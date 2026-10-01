import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeWindowsTaskIdentity,
  resolveGatewayProfileSuffix,
} from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import {
  discoverManagedGatewayBindings,
  describeManagedGatewayBinding,
  readManagedGatewayBindingState,
  type ManagedGatewayBinding,
} from "../../daemon/managed-gateway-bindings.js";
import { resolveTaskName } from "../../daemon/schtasks-layout.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { gatewayServiceCommandOverlapsPhysicalInstallation } from "../../daemon/service-layout.js";
import { isGatewayServiceStateLive } from "../../daemon/service-runtime.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { formatCliCommand } from "../command-format.js";
import { UpdatePreMutationError } from "./shared.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
  observedSystemdManagerUid,
} from "./update-command-service-plan.js";

function matchesStoppedService(
  before: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">,
  state: GatewayServiceState,
  inspection: ManagedGatewayUpdateVerdict,
  allowIncompleteInspection = false,
): boolean {
  const verdict = before.serviceUpdateVerdict;
  const refreshDefinition = verdict?.kind === "owned" && verdict.refreshDefinition;
  const resolveName =
    process.platform === "darwin"
      ? resolveLaunchAgentLabel
      : process.platform === "win32"
        ? (env: GatewayServiceState["env"]) => normalizeWindowsTaskIdentity(resolveTaskName(env))
        : resolveSystemdServiceName;
  // Explicit default metadata selects the same manager; protected command hashes
  // still pin the effective launcher and its environment through normalization.
  // Stable 2026.9.2/2026.9.3 handoffs omit the UID; compare it when recorded.
  return Boolean(
    before.serviceEnv &&
    state.command &&
    verdict &&
    "fingerprint" in verdict &&
    resolveGatewayProfileSuffix(before.serviceEnv.OPENCLAW_PROFILE) ===
      resolveGatewayProfileSuffix(state.env.OPENCLAW_PROFILE) &&
    resolveName(before.serviceEnv) === resolveName(state.env) &&
    (process.platform !== "linux" ||
      before.serviceManagerUid === undefined ||
      (allowIncompleteInspection && observedSystemdManagerUid(state) === undefined) ||
      before.serviceManagerUid === observedSystemdManagerUid(state)) &&
    (refreshDefinition ||
      ("fingerprint" in inspection && inspection.fingerprint === verdict.fingerprint)),
  );
}

/** Observe other consumers; discovery never grants permission to stop them. */
export async function assertManagedGatewayArtifactPublication(params: {
  roots: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  assertCurrent: () => void;
  selected?: PreManagedServiceStop;
  updateInstallKind: "git" | "package" | "unknown";
  shouldRestart: boolean;
  phase?: "before-stop" | "publication";
  inspectOverlap?: typeof gatewayServiceCommandOverlapsPhysicalInstallation;
}): Promise<void> {
  params.assertCurrent();
  const serving = params.selected;
  const servingVerdict = serving?.serviceUpdateVerdict;
  if (
    (params.phase !== "before-stop" || !params.shouldRestart) &&
    params.updateInstallKind === "git" &&
    serving?.running &&
    !serving.stopped &&
    servingVerdict?.kind === "owned" &&
    params.roots.some((root) => updateInstallRootsMatch(root, servingVerdict.root))
  ) {
    throw new UpdatePreMutationError(
      "runtime-artifact-publication",
      `Cannot replace Git runtime artifacts in ${servingVerdict.root}: its Gateway${serving.servicePid === undefined ? "" : ` (PID ${serving.servicePid})`} is still running and this update did not stop it. Stop that Gateway through its service manager, then rerun \`${formatCliCommand("openclaw update", serving.serviceEnv)}\` without \`--no-restart\`. The serving runtime was left unchanged.`,
    );
  }
  const bindings = await discoverManagedGatewayBindings(params.env);
  params.assertCurrent();
  const readBinding = async (binding: ManagedGatewayBinding) => {
    const state = await readManagedGatewayBindingState(binding, {
      timeoutMs: params.timeoutMs,
    }).catch((error: unknown) => {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      // Unavailable observation is neither absence nor a positively observed consumer.
      return undefined;
    });
    params.assertCurrent();
    return state;
  };
  const before =
    params.phase === "before-stop" || (params.updateInstallKind !== "git" && !params.shouldRestart)
      ? serving
      : undefined;
  const retained = before?.serviceUpdateVerdict;
  let selectedState: GatewayServiceState | undefined;
  const selectedConsumer = async (
    binding: ManagedGatewayBinding,
    state: Awaited<ReturnType<typeof readManagedGatewayBindingState>>,
  ): Promise<boolean> => {
    if (!before?.serviceEnv || retained?.kind !== "owned") {
      return false;
    }
    let observed = state;
    if (process.platform === "linux") {
      observed = {
        ...state,
        env: mergeGatewayServiceEnv(
          { ...state.env, OPENCLAW_PROFILE: before.serviceEnv.OPENCLAW_PROFILE },
          state.command,
        ),
      };
    }
    if (process.platform === "darwin") {
      if (
        !state.launchAgent ||
        (before.servicePid !== undefined && before.servicePid !== state.runtime?.pid)
      ) {
        return false;
      }
      const { readCorrespondingLaunchAgentCommand } =
        await import("../../daemon/launchd-runtime.js");
      const command = await readCorrespondingLaunchAgentCommand(
        before.serviceEnv,
        state.launchAgent,
        params.timeoutMs,
      );
      params.assertCurrent();
      if (!command) {
        return false;
      }
      observed = { ...state, command, env: mergeGatewayServiceEnv(before.serviceEnv, command) };
    }
    const startupEntry = binding.windowsStartupEntry;
    if (startupEntry !== undefined) {
      // Only the selected Task's proven absence can select its Startup fallback.
      selectedState ??= await readBinding({
        env: before.serviceEnv,
      });
      const normalize = (value: string) => path.win32.normalize(value).toLowerCase();
      if (
        !selectedState?.command?.startupEntryPaths?.some(
          (entry) => normalize(entry) === normalize(startupEntry),
        ) ||
        !state.command?.sourcePath ||
        !selectedState.command.sourcePath ||
        normalize(state.command.sourcePath) !== normalize(selectedState.command.sourcePath)
      ) {
        return false;
      }
      const effectiveCommand = (command: NonNullable<GatewayServiceState["command"]>) => {
        const {
          sourcePath: _sourcePath,
          definitionPaths: _definitionPaths,
          startupEntryPaths: _startupEntryPaths,
          ...effective
        } = command;
        return effective;
      };
      if (
        !isDeepStrictEqual(effectiveCommand(state.command), effectiveCommand(selectedState.command))
      ) {
        return false;
      }
      observed = selectedState;
    }
    const inspection = await inspectManagedGatewayServiceBeforeUpdate({
      state: observed,
      root: retained.root,
      retainedCommand: true,
    });
    params.assertCurrent();
    return matchesStoppedService(
      { ...before, serviceUpdateVerdict: { ...retained, refreshDefinition: false } },
      observed,
      inspection,
    );
  };
  for (const binding of bindings) {
    const state = await readBinding(binding);
    if (!state || !isGatewayServiceStateLive(state)) {
      continue;
    }
    for (const root of params.roots) {
      const overlaps = await (
        params.inspectOverlap ?? gatewayServiceCommandOverlapsPhysicalInstallation
      )(root, state.command);
      params.assertCurrent();
      if (overlaps !== true || (await selectedConsumer(binding, state))) {
        continue;
      }
      const owner = describeManagedGatewayBinding(binding, state);
      throw new UpdatePreMutationError(
        "runtime-artifact-publication",
        `Cannot replace ${root}: another managed Gateway (${owner}) is still using this installation. Stop that Gateway through its own service manager or Startup process, then retry the update. Its files and service were left unchanged.`,
      );
    }
  }
  params.assertCurrent();
}

export async function revalidateManagedGatewayServiceAfterUpdate(params: {
  state: GatewayServiceState;
  root: string;
  preManagedServiceStop?: Pick<
    PreManagedServiceStop,
    "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid"
  >;
  allowInstallRootChange?: boolean;
  /** Restoration still rejects observed identity drift when a native probe fails. */
  allowIncompleteInspection?: boolean;
}): Promise<ManagedGatewayUpdateVerdict> {
  const before = params.preManagedServiceStop;
  const verdict = before?.serviceUpdateVerdict;
  assertGatewayServiceManagementAllowedForUpdate(params.state.env);
  const managerUid = observedSystemdManagerUid(params.state);
  if (
    params.allowIncompleteInspection &&
    before?.serviceManagerUid !== undefined &&
    managerUid !== undefined &&
    managerUid !== before.serviceManagerUid
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
      undefined,
      "service-ownership-changed",
    );
  }
  // Shipped handoffs and package root swaps retain the exact launcher fingerprint.
  const inspection = await inspectManagedGatewayServiceBeforeUpdate({
    ...params,
    retainedCommand: verdict?.kind === "owned" || verdict?.kind === "unresolved",
    allowInstallRootChange: params.allowInstallRootChange && !verdict,
  });
  if (
    (params.allowInstallRootChange ||
      (verdict?.kind === "owned" && verdict.requiresInstallRootRefresh)) &&
    before &&
    verdict?.kind === "owned" &&
    verdict.refreshDefinition &&
    (inspection.kind === "foreign" || inspection.kind === "unresolved") &&
    (params.state.definitionMutationCapability?.kind ?? "writable") === "writable"
  ) {
    const retained = await inspectManagedGatewayServiceBeforeUpdate({
      state: params.state,
      root: verdict.root,
      retainedCommand: true,
      allowIncompleteInspection: params.allowIncompleteInspection,
    });
    // A verified core install can replace its root before rewriting the launcher.
    // Pin the original command even when pnpm has removed its old package directory.
    if (
      matchesStoppedService(
        { ...before, serviceUpdateVerdict: { ...verdict, refreshDefinition: false } },
        params.state,
        retained,
        params.allowIncompleteInspection,
      )
    ) {
      return { ...verdict, requiresInstallRootRefresh: true };
    }
  }
  if (
    before &&
    verdict &&
    (verdict.kind === "owned" || verdict.kind === "unresolved") &&
    !(params.allowIncompleteInspection && inspection.kind === "unavailable") &&
    (inspection.kind !== verdict.kind ||
      !matchesStoppedService(before, params.state, inspection, params.allowIncompleteInspection))
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      inspection.kind === "unavailable"
        ? params.state.runtime?.inspectionFailure?.timeoutMs !== undefined
          ? inspection.message
          : "Gateway service ownership could not be verified because inspection is unavailable. Run `openclaw gateway status --deep` and retry."
        : "Gateway service ownership or manager identity changed; inspect it before restarting manually.",
      undefined,
      inspection.kind === "unavailable" ? inspection.inspectionReason : undefined,
      inspection.kind === "unavailable" ? undefined : "service-ownership-changed",
    );
  }
  return inspection.kind === "owned" && verdict?.kind === "owned" && !verdict.refreshDefinition
    ? { ...inspection, refreshDefinition: false }
    : inspection;
}
