import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { isDefaultInstallIdentity, resolveIsNixMode } from "../config/paths.js";
import { resolveNodeServiceIdentityEnvironment } from "../daemon/constants.js";
import { resolveNodeService } from "../daemon/node-service.js";
import { resolveNodeServiceEntrypoint } from "../daemon/program-args.js";
import { resolveRuntimeScriptPosition } from "../daemon/runtime-binary.js";
import {
  readDaemonRuntimePin,
  withDaemonRuntimePinMigration,
} from "../daemon/runtime-pin-state.js";
import type { ServiceDefinitionDrift } from "../daemon/service-audit-types.js";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import {
  assertServiceDefinitionWritable,
  hasGatewayServiceLauncherOverride,
  resolveManagedGatewayServiceCommand,
} from "../daemon/service-types.js";
import { GatewayServiceAuthorityError } from "../daemon/service-update-authority.js";
import { formatInstallOwnerMessage, readInstallOwner } from "../infra/install-owner.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  assertDoctorServiceSelection,
  isServiceRepairDeferred,
  resolveServiceRepairPolicy,
} from "./doctor-service-repair-policy.js";

/** Repair the shipped direct-entry node definition without rebuilding its launch options. */
export async function maybeRepairNodeServiceConfig(
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isDefaultInstallIdentity(env) || resolveIsNixMode(env)) {
    return;
  }
  const service = resolveNodeService();
  try {
    const command = await service.readCommand(env, { requireEffective: true });
    const managed = resolveManagedGatewayServiceCommand(command);
    if (!command || !managed) {
      return;
    }
    const { position } = resolveRuntimeScriptPosition(managed.programArguments);
    if (
      typeof position !== "number" ||
      !/[\\/]dist[\\/]index\.m?js$/u.test(managed.programArguments[position] ?? "") ||
      managed.programArguments[position + 1] !== "node" ||
      managed.programArguments[position + 2] !== "run"
    ) {
      return;
    }
    note(
      "Node service bypasses the node-host launcher, so automatic node updates cannot start. Run openclaw doctor --fix to repair it.",
      "Node service",
    );
    if (isServiceRepairDeferred(resolveServiceRepairPolicy(env))) {
      note(
        "Node service repair deferred; its definition and activation were left unchanged.",
        "Node service",
      );
      return;
    }
    if (
      hasGatewayServiceLauncherOverride(command) ||
      managed.environment?.OPENCLAW_WRAPPER?.trim()
    ) {
      note(
        "Node service has a custom launcher. Update that launcher to invoke openclaw.mjs or dist/entry.js; it was left unchanged.",
        "Node service",
      );
      return;
    }
    const root = await resolveOpenClawPackageRoot({ argv1: managed.programArguments[position] });
    if (!root) {
      note(
        "Node service package ownership could not be verified; its definition was left unchanged.",
        "Node service",
      );
      return;
    }
    const owner = await readInstallOwner(root);
    if (owner) {
      note(formatInstallOwnerMessage(owner), "Node service");
      return;
    }
    const programArguments = [...managed.programArguments];
    programArguments[position] = await resolveNodeServiceEntrypoint(
      managed.programArguments[position],
    );
    const serviceEnv = mergeGatewayServiceEnv(env, command);
    assertDoctorServiceSelection(env, serviceEnv);
    const nativeEnv = { ...serviceEnv, ...resolveNodeServiceIdentityEnvironment(serviceEnv) };
    const drift: ServiceDefinitionDrift[] = [];
    let driftError: string | undefined;
    if (process.platform === "darwin") {
      const { auditLaunchdDefinition } = await import("../daemon/service-audit-launchd.js");
      await auditLaunchdDefinition(nativeEnv, [], drift, undefined, true);
    } else if (process.platform === "linux") {
      const { auditSystemdUnit } = await import("../daemon/service-audit-systemd.js");
      driftError = await auditSystemdUnit(nativeEnv, [], undefined, command, drift, true);
    } else if (process.platform === "win32") {
      const { auditScheduledTaskDefinition } = await import("../daemon/service-audit-schtasks.js");
      await auditScheduledTaskDefinition(nativeEnv, drift, undefined, {
        ...managed,
        programArguments,
      });
    }
    // The native installer preserves arguments/env but needs a transaction to preserve custom policy.
    // Leave customized definitions with their owner instead of silently resetting those settings.
    if (driftError || drift.some((fact) => fact.kind !== "outdated")) {
      note(
        "Node service has custom or unverified native settings. Reinstall with openclaw node install --force after preserving those settings; it was left unchanged.",
        "Node service",
      );
      return;
    }
    const capability = await service.readDefinitionMutationCapability?.({
      env: serviceEnv,
      environment: managed.environment,
    });
    if (capability) {
      assertServiceDefinitionWritable(capability);
    }
    if (
      !(await prompter.confirmRuntimeRepair({
        message: "Repair the node service launcher?",
        initialValue: true,
      }))
    ) {
      return;
    }
    const pin = await withDaemonRuntimePinMigration(nativeEnv, () =>
      readDaemonRuntimePin({ kind: "node", env: serviceEnv }, command),
    );
    const state = await service.readRuntime(serviceEnv, {
      commandInspection: { kind: "present", command },
    });
    if (state.status !== "running" && state.status !== "stopped") {
      note(
        "Node service runtime could not be inspected; its definition was left unchanged.",
        "Node service",
      );
      return;
    }
    const args = {
      env: serviceEnv,
      stdout: process.stdout,
      ...managed,
      programArguments,
      preserveAutoStart: true,
      runtimePinUpdate: { expected: pin, pin: pin.pin, requireDefinitionMatch: true as const },
      beforeMutation: async () => {
        if (
          isServiceRepairDeferred(resolveServiceRepairPolicy(env)) ||
          !isDeepStrictEqual(await service.readCommand(env, { requireEffective: true }), command)
        ) {
          throw new Error(
            "Node service changed during Doctor; rerun doctor to inspect its current definition.",
          );
        }
      },
      warn: (message: string) => note(message, "Node service"),
    };
    if (state.status === "running") {
      await service.install(args);
      if (process.platform === "win32") {
        await service.restart({ env: serviceEnv, stdout: process.stdout });
      }
      note(
        "Node service launcher repaired and restarted; automatic node updates can now start.",
        "Node service",
      );
    } else {
      await service.stage(args);
      note(
        "Node service launcher repaired; its stopped state was preserved. Run openclaw node start when ready.",
        "Node service",
      );
    }
  } catch (error) {
    if (error instanceof GatewayServiceAuthorityError || hasCommandProcessCleanupError(error)) {
      throw error;
    }
    runtime.error(`Node service repair did not complete: ${String(error)}`);
  }
}
