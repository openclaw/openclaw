import path from "node:path";
import { normalizeHomeDirValue } from "@openclaw/normalization-core/home-dir";
import {
  captureClawInstallSchemaVersionFacts,
  prepareClawInstallSchemaVersions,
  withClawInstallSchemaVersionFacts,
} from "../claws/provenance-runtime-read.js";
import { collectClawToolPolicyCandidates } from "../claws/tool-policy-candidates.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  captureRuntimeConfigWithSource,
  getRuntimeConfigCapture,
} from "../config/runtime-config-capture-state.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { loadExecApprovalsReadOnlyAsync } from "../infra/exec-approvals-store.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
export type ToolConstructionPreparationOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type CapturedToolConstruction = {
  config: OpenClawConfig | undefined;
  env: NodeJS.ProcessEnv;
  cwd: string;
  statePath: string;
  admitStateRead: () => void;
  assertCurrent: () => void;
};

export type PreparedToolConstruction = Omit<
  CapturedToolConstruction,
  "statePath" | "admitStateRead"
> & {
  loadExecApprovals: () => Promise<ExecApprovalsFile>;
};

/** Retain construction inputs across reads; they never grant execution authority. */
function captureToolConstructionScope(
  config: OpenClawConfig | undefined,
  options: ToolConstructionPreparationOptions,
): CapturedToolConstruction {
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  // Anchor routing inputs before canonical home/state resolution can observe a later cwd.
  for (const key of ["HOME", "USERPROFILE", "PREFIX"] as const) {
    const value = normalizeHomeDirValue(env[key]);
    if (value) {
      env[key] = path.resolve(cwd, value);
    }
  }
  const explicitHome = normalizeHomeDirValue(env.OPENCLAW_HOME);
  if (explicitHome && !/^~(?:[\\/]|$)/u.test(explicitHome)) {
    env.OPENCLAW_HOME = path.resolve(cwd, explicitHome);
  }
  env.OPENCLAW_HOME = resolveRequiredHomeDir(env);
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir && !/^~(?:[\\/]|$)/u.test(stateDir)) {
    env.OPENCLAW_STATE_DIR = path.resolve(cwd, stateDir);
  }
  Object.assign(env, captureSessionTranscriptStorageEnvironment(env));
  const capturedConfig = config
    ? captureRuntimeConfigWithSource(config, getRuntimeConfigCapture(config)?.source ?? config)
    : undefined;
  const statePath = path.resolve(cwd, resolveOpenClawStateSqlitePath(env));
  let assertStateCurrent: (() => void) | undefined;
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    assertStateCurrent?.();
  };
  assertCurrent();
  return {
    config: capturedConfig,
    env,
    cwd,
    statePath,
    admitStateRead: () => {
      assertCurrent();
      assertStateCurrent ??= captureOpenClawStateWorkerContext({ path: statePath, env }).admission
        .assertCurrent;
      assertCurrent();
    },
    assertCurrent,
  };
}

async function loadToolConstructionExecApprovals(
  scope: CapturedToolConstruction,
): Promise<ExecApprovalsFile> {
  const { statePath, env, assertCurrent } = scope;
  scope.admitStateRead();
  const file = await loadExecApprovalsReadOnlyAsync({ path: statePath, env });
  assertCurrent();
  return file;
}

export async function withPreparedToolConstruction<T>(
  config: OpenClawConfig | undefined,
  options: ToolConstructionPreparationOptions,
  consume: (facts: PreparedToolConstruction) => T | Promise<T>,
): Promise<T> {
  const scope = captureToolConstructionScope(config, options);
  const { config: capturedConfig, env, cwd, statePath, assertCurrent } = scope;
  const run = async () => {
    let active = true;
    const assertPreparedCurrent = () => {
      if (!active) {
        throw new Error("Tool construction preparation has ended");
      }
      assertCurrent();
    };
    try {
      assertPreparedCurrent();
      const result = await consume({
        config: capturedConfig,
        env,
        cwd,
        loadExecApprovals: async () => {
          assertPreparedCurrent();
          const approvals = await loadToolConstructionExecApprovals(scope);
          assertPreparedCurrent();
          return approvals;
        },
        assertCurrent: assertPreparedCurrent,
      });
      assertPreparedCurrent();
      return result;
    } finally {
      active = false;
    }
  };
  if (!capturedConfig || collectClawToolPolicyCandidates(capturedConfig).length === 0) {
    return await run();
  }
  scope.admitStateRead();
  const provenance = await prepareClawInstallSchemaVersions({
    path: statePath,
    env,
    artifactPreservingReadOnly: false,
  });
  assertCurrent();
  provenance.publish();
  assertCurrent();
  const provenanceFacts = captureClawInstallSchemaVersionFacts({ path: statePath, env });
  return await withClawInstallSchemaVersionFacts(provenanceFacts, async () => {
    // The existing handoff also covers a preparer registered by this late import.
    const { prepareCapturedClawToolPolicyConsent } =
      await import("../claws/tool-policy-runtime.js");
    assertCurrent();
    prepareCapturedClawToolPolicyConsent(capturedConfig, { path: statePath, env });
    return await run();
  });
}
