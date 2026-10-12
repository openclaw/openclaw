import { isDeepStrictEqual } from "node:util";
import type { SystemAgentSetupAutoResult } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveConfiguredPrimaryModelForAgent } from "../../agents/utility-model.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { applyMergePatch, createMergePatch } from "../../config/merge-patch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { transformConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { appendSystemAgentAuditEntry } from "../../system-agent/audit.js";
import { prepareAutomaticSetupCodex } from "../../system-agent/setup-inference-codex.js";
import {
  SetupInferenceActivationIndeterminateError,
  SetupInferenceOwnerDriftError,
  redactSetupInferenceError,
  type SetupInferenceCandidate,
} from "../../system-agent/setup-inference-core.js";
import { detectSetupInference } from "../../system-agent/setup-inference-detect.js";
import { rankSetupInferenceCandidates } from "../../system-agent/setup-inference-ranking.js";
import {
  captureSetupInferenceFileUndo,
  commitSetupInferenceActivation,
  setupConfigPatchConflicts,
  type SetupInferenceConfigTarget,
} from "../../system-agent/setup-inference-transition.js";
import { applySetupNativeSessionCatalogPreference } from "../../system-agent/setup-native-session-catalogs.js";
import { runExclusiveSystemAgentSetupActivation } from "./setup-admission.js";
import {
  activateGatewaySetupInference,
  createSystemAgentGatewayRuntime,
  runSystemAgentGatewayTask,
} from "./system-agent-execution.js";
import type { GatewayRequestContext } from "./types.js";

const runs = new WeakMap<
  GatewayRequestContext["wizardSessions"],
  Promise<SystemAgentSetupAutoResult>
>();

function present(candidate: SetupInferenceCandidate) {
  const { kind, label, detail, modelRef, brandId, icon } = candidate;
  return {
    kind,
    label,
    detail,
    modelRef,
    ...(brandId ? { brandId } : {}),
    ...(icon ? { icon } : {}),
  };
}

/** Accepted setup belongs to the Gateway; disconnecting a joining caller does not cancel it. */
export function runGatewayAutomaticSetup(
  context: GatewayRequestContext,
): Promise<SystemAgentSetupAutoResult> {
  const previous = runs.get(context.wizardSessions);
  if (previous) {
    return previous;
  }
  const run = runExclusiveSystemAgentSetupActivation(() => autoSetup());
  runs.set(context.wizardSessions, run);
  void run.finally(() => runs.delete(context.wizardSessions)).catch(() => {});
  return run;
}

async function autoSetup(): Promise<SystemAgentSetupAutoResult> {
  const runtime = createSystemAgentGatewayRuntime();
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  const detection = await runSystemAgentGatewayTask(() => detectSetupInference());
  let ranked = rankSetupInferenceCandidates(detection.candidates);
  const attempts: SystemAgentSetupAutoResult["attempts"] = [];
  const failed = new Set<string>();
  const installedPlugins: string[] = [];
  const result = (
    status: SystemAgentSetupAutoResult["status"],
    selected?: SetupInferenceCandidate,
  ): SystemAgentSetupAutoResult => ({
    status,
    ...(selected ? { selected: present(selected) } : {}),
    alternatives: ranked
      .filter((candidate) => candidate !== selected && !failed.has(candidate.kind))
      .map(present),
    attempts,
    installedPlugins,
  });
  if (detection.setupComplete) {
    const selected = ranked.find((candidate) => candidate.kind === "existing-model");
    if (selected) {
      return result("configured", selected);
    }
    const snapshot = await readConfigFileSnapshot();
    const modelRef = resolveConfiguredPrimaryModelForAgent({
      cfg: snapshot.config,
      agentId: resolveAmbientOwnerAgentId(snapshot.config),
    });
    if (modelRef) {
      return result("configured", {
        kind: "existing-model",
        label: "Current model",
        detail: "Already configured",
        modelRef,
        recommended: true,
        credentials: true,
      });
    }
    throw new Error("The configured model changed during automatic setup. Retry setup.");
  }
  const initialSnapshot = await readConfigFileSnapshot();
  const codexWasEnabled = resolvePluginMetadataSnapshot({
    config: initialSnapshot.config,
    workspaceDir: detection.workspace,
  }).index.plugins.some((plugin) => plugin.pluginId === "codex" && plugin.enabled);
  const recordCodexInstall = () => {
    if (!codexWasEnabled && !installedPlugins.includes("codex")) {
      installedPlugins.push("codex");
    }
  };
  const activate = async (candidate: SetupInferenceCandidate) => {
    assertCurrent();
    let commitStarted = false;
    const activation = await activateGatewaySetupInference({
      kind: candidate.kind,
      modelRef: candidate.modelRef,
      surface: "gateway",
      runtime,
      signal,
      automaticSetup: true,
      activationConfirmed: true,
      nativeSessionCatalogsEnabled: false,
      beforePersistentEffect: assertCurrent,
      onCommitStarted: () => {
        commitStarted = true;
      },
    }).catch(async (error: unknown) => {
      if (
        commitStarted ||
        error instanceof SetupInferenceActivationIndeterminateError ||
        signal?.aborted
      ) {
        throw error;
      }
      return { ok: false as const, error: await redactSetupInferenceError(error) };
    });
    if (activation.ok) {
      candidate.modelRef = activation.modelRef;
      if (candidate.kind === "codex-cli") {
        recordCodexInstall();
      }
      return true;
    }
    failed.add(candidate.kind);
    attempts.push({ kind: candidate.kind, label: candidate.label, error: activation.error });
    return false;
  };
  // Reserve the fourth attempt for Codex after managed installation and re-detection.
  for (const candidate of ranked.slice(0, 3)) {
    if (await activate(candidate)) {
      return result("activated", candidate);
    }
  }
  try {
    let complete: (() => Promise<boolean>) | undefined;
    try {
      await runSystemAgentGatewayTask(async () => {
        const snapshot = await readConfigFileSnapshot();
        assertCurrent();
        const prepared = await prepareAutomaticSetupCodex({
          cfg: snapshot.runtimeConfig ?? snapshot.config,
          workspace: detection.workspace,
          runtime,
          signal,
          beforePersistentEffect: assertCurrent,
        });
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
        const config = applySetupNativeSessionCatalogPreference({
          config: prepared.config,
          workspaceDir: detection.workspace,
          enabled: false,
        });
        const patch = createMergePatch(snapshot.runtimeConfig ?? snapshot.config, config);
        const target: SetupInferenceConfigTarget = {
          read: async () => ({
            config: (await readConfigFileSnapshot()).sourceConfig,
            write: target.write,
          }),
          write: async (_config, { writeOptions, captureUndo }) => {
            const committed = await transformConfigWithPendingPluginInstalls({
              base: "source",
              writeOptions,
              transform: (current, { snapshot: latest }) => {
                assertCurrent();
                if (setupConfigPatchConflicts(snapshot.sourceConfig, current, patch)) {
                  throw new SetupInferenceOwnerDriftError(
                    "Setup settings changed while preparing Codex. Retry automatic setup.",
                  );
                }
                // SAFETY: The patch comes from typed configs; the writer validates the result.
                const nextConfig = applyMergePatch(current, patch) as OpenClawConfig;
                captureUndo(captureSetupInferenceFileUndo(latest, nextConfig));
                return { nextConfig };
              },
            });
            return committed.nextConfig;
          },
        };
        if (!isDeepStrictEqual(config, snapshot.runtimeConfig ?? snapshot.config)) {
          await commitSetupInferenceActivation({
            config,
            configTarget: target,
            preserveWorkingConnection: true,
            assertCurrent,
            activate: async () => undefined,
            deferCompletion: (completion) => {
              complete = completion;
            },
          });
        }
        recordCodexInstall();
      });
    } finally {
      await complete?.();
    }
    try {
      await appendSystemAgentAuditEntry({
        operation: "openclaw.setup.auto",
        summary: "Prepared the official Codex plugin for automatic setup",
        details: { source: "automatic-setup", pluginId: "codex" },
      });
    } catch (error) {
      runtime.error?.(
        `Codex is prepared, but its setup audit could not be recorded: ${await redactSetupInferenceError(error)}`,
      );
    }
    const refreshed = await runSystemAgentGatewayTask(() => detectSetupInference());
    ranked = rankSetupInferenceCandidates(refreshed.candidates);
    const codex = ranked.find((candidate) => candidate.kind === "codex-cli");
    if (codex && attempts.length < 4 && (await activate(codex))) {
      return result("activated", codex);
    }
    if (!codex) {
      const signIn = refreshed.authOptions.find(
        (option) =>
          option.brandId === "openai" && (option.kind === "oauth" || option.kind === "device-code"),
      );
      if (signIn) {
        return {
          ...result("needs-sign-in"),
          signIn: { authOptionId: signIn.id, label: signIn.label },
        };
      }
      throw new Error("Codex is installed, but its ChatGPT sign-in option is unavailable.");
    }
  } catch (error) {
    if (error instanceof SetupInferenceActivationIndeterminateError || signal?.aborted) {
      throw error;
    }
    const detail = await redactSetupInferenceError(error);
    const lastAttempt = attempts.at(-1);
    if (attempts.length === 4 && lastAttempt) {
      lastAttempt.error += ` Codex preparation also failed: ${detail}`;
    } else {
      attempts.push({ kind: "codex-cli", label: "Codex", error: detail });
    }
  }
  return result("unavailable");
}
