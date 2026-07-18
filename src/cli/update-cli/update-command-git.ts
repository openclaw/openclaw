import fs from "node:fs/promises";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createGlobalInstallEnv,
  globalInstallArgs,
  resolveGlobalInstallTarget,
  resolvePnpmGlobalDirFromGlobalRoot,
} from "../../infra/update-global.js";
import {
  runGatewayUpdate,
  type UpdateRunResult,
  type UpdateStepResult,
} from "../../infra/update-runner.js";
import { prepareGitMutation } from "../../infra/update-runner-git-target.js";
import { defaultRuntime } from "../../runtime.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawDatabaseSchemas,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { completeManagedGitCheckout, isManagedGitCheckoutRetry } from "./managed-checkout.js";
import {
  createGlobalCommandRunner,
  createGitCheckout,
  createSanitizedGitEnv,
  resolveGitInstallDir,
  resolveGlobalManager,
  runUpdateStep,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  createAggregateErrorWithCause,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

type BeforeGitMutation = (target: {
  schemaVersions?: OpenClawSchemaVersions;
  metadataUnreadable?: string;
}) => Promise<{
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
} | void>;

export function formatSchemaRefusalLines(
  schemas: {
    incompatible: readonly IncompatibleOpenClawDatabase[];
    indeterminate: readonly IndeterminateOpenClawDatabase[];
  },
  dryRun = false,
): string[] {
  const prefix = dryRun ? "Would refuse update" : "Update refused";
  return [
    ...schemas.incompatible.map((database) => {
      const agent = database.agentId ? ` (agent ${database.agentId})` : "";
      return `${prefix}: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`;
    }),
    ...schemas.indeterminate.map(
      (database) =>
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

export function checkTargetDatabaseSchemas(
  supportedVersions: OpenClawSchemaVersions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawDatabaseSchemaPreflight {
  return supportedVersions
    ? preflightOpenClawDatabaseSchemas({ env, supportedVersions })
    : { incompatible: [], indeterminate: [] };
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}

export function createBeforeGitMutation(params: {
  roots: readonly string[];
  shouldRestart: boolean;
  stopManagedService: (roots: readonly string[]) => Promise<void>;
  getPreManagedServiceStop: () => PreManagedServiceStop | undefined;
  markSchemaRefusalAfterStop: () => void;
}): BeforeGitMutation {
  // A managed retry validates before swapping, then the runner validates its selected target.
  // Stop the service once, but never let the cached preparation bypass the second schema check.
  let preparation: {
    allowGatewayServiceRepair?: boolean;
    allowGatewayActivation?: boolean;
  } | null = null;
  return async (target) => {
    if (target?.metadataUnreadable) {
      if (preparation) {
        params.markSchemaRefusalAfterStop();
      }
      defaultRuntime.error(
        `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
      );
      if (!preparation) {
        defaultRuntime.exit(1);
      }
      throw new UpdateCommandAbort();
    }
    const preManagedServiceStop = params.getPreManagedServiceStop();
    const preStopSchemas = checkTargetDatabaseSchemas(
      target?.schemaVersions,
      preparation ? (preManagedServiceStop?.serviceEnv ?? process.env) : process.env,
    );
    if (hasSchemaRefusal(preStopSchemas)) {
      if (preparation) {
        params.markSchemaRefusalAfterStop();
      }
      defaultRuntime.error(formatSchemaRefusalLines(preStopSchemas).join("\n"));
      if (!preparation) {
        defaultRuntime.exit(1);
      }
      throw new UpdateCommandAbort();
    }
    if (preparation) {
      return preparation;
    }
    await params.stopManagedService(params.roots);
    const stoppedService = params.getPreManagedServiceStop();
    const postStopSchemas = checkTargetDatabaseSchemas(
      target?.schemaVersions,
      stoppedService?.serviceEnv ?? process.env,
    );
    if (hasSchemaRefusal(postStopSchemas)) {
      params.markSchemaRefusalAfterStop();
      defaultRuntime.error(formatSchemaRefusalLines(postStopSchemas).join("\n"));
      throw new UpdateCommandAbort();
    }
    preparation = {
      // Only a positively owned service may be rewritten. Activation
      // additionally requires this update to have stopped it.
      allowGatewayServiceRepair: stoppedService?.serviceMatchesMutationRoot === true,
      allowGatewayActivation:
        params.shouldRestart &&
        stoppedService?.stopped === true &&
        stoppedService.serviceMatchesMutationRoot === true,
    };
    return preparation;
  };
}

export async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: UpdateChannel;
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
  devTargetRef?: string;
  beforeGitMutation?: BeforeGitMutation;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const installEnv = await createGlobalInstallEnv();
  const freshCheckoutEnv = params.switchToGit ? createSanitizedGitEnv(installEnv) : undefined;
  const managedCheckoutRetry = params.switchToGit
    ? await isManagedGitCheckoutRetry(updateRoot, installEnv)
    : false;
  const cleanupCreatedCheckout = async (primaryError?: unknown): Promise<void> => {
    if (!params.switchToGit) {
      return;
    }
    try {
      await fs.rm(updateRoot, { recursive: true, force: true });
      await completeManagedGitCheckout(updateRoot, installEnv);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw createAggregateErrorWithCause(
          [primaryError, cleanupError],
          `Package-to-dev conversion failed (${formatErrorMessage(primaryError)}) and its new checkout could not be removed (${formatErrorMessage(cleanupError)})`,
          primaryError,
        );
      }
      throw cleanupError;
    }
  };

  const cloneStep = params.switchToGit
    ? await createGitCheckout({
        dir: updateRoot,
        env: installEnv,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
        beforeReplaceManagedCheckout: async (stagingDir) => {
          const runCommand = createGlobalCommandRunner();
          await prepareGitMutation({
            runCommand: async (argv, options) =>
              await runCommand(argv, {
                cwd: options.cwd,
                timeoutMs: options.timeoutMs ?? effectiveTimeout,
                env: freshCheckoutEnv,
              }),
            root: stagingDir,
            revision: "HEAD",
            timeoutMs: effectiveTimeout,
            beforeGitMutation: params.beforeGitMutation,
          });
        },
      })
    : null;

  if (cloneStep && cloneStep.exitCode !== 0) {
    if (!managedCheckoutRetry) {
      await cleanupCreatedCheckout();
    }
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: cloneStep.name,
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
    devTargetRef: params.devTargetRef,
    deferConfiguredPluginInstallRepair: true,
    allowGatewayServiceRepair: params.allowGatewayServiceRepair,
    allowGatewayActivation: params.allowGatewayActivation,
    beforeGitMutation: params.beforeGitMutation,
    commandEnv: freshCheckoutEnv,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: effectiveTimeout,
    });
    const runCommand = createGlobalCommandRunner();
    const installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: effectiveTimeout,
      pkgRoot: params.root,
    });
    const installLocation =
      installTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installTarget.globalRoot)
        : null;
    const installArgv = globalInstallArgs(
      installTarget,
      updateRoot,
      undefined,
      installLocation,
      updateRoot,
    );
    // From this point onward the package manager may already have persisted a
    // symlink to updateRoot even when it later reports failure. Preserve the
    // checkout so a failed install never leaves the global CLI dangling.
    const installStep: UpdateStepResult = await runUpdateStep({
      name: "global install",
      argv: installArgv,
      cwd: updateRoot,
      env: installEnv,
      timeoutMs: effectiveTimeout,
      progress: params.progress,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    if (!failedStep) {
      await completeManagedGitCheckout(updateRoot, installEnv);
    }
    return {
      ...updateResult,
      status: failedStep ? "error" : "ok",
      steps,
      durationMs: Date.now() - params.startedAt,
    };
  }

  if (params.switchToGit) {
    const doctorMayHaveRewrittenService = updateResult.steps.some(
      (step) => step.name === "openclaw doctor",
    );
    if (!managedCheckoutRetry && !doctorMayHaveRewrittenService) {
      await cleanupCreatedCheckout();
    }
  }

  return {
    ...updateResult,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}
