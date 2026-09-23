import "./subagent-spawn-model.mocks.shared.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { resetTaskFlowRegistryForTests } from "../../../tasks/task-flow-registry.test-support.js";
import {
  configureInMemoryTaskStoresForTests,
  resetTaskRegistryForTests,
} from "../../../tasks/task-registry.test-support.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { SubagentRegistryWriteError } from "../registry/subagent-registry-persistence.js";
import * as registryState from "../registry/subagent-registry-state.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import { prepareDynamicsSpawn } from "../swarm/dynamics/dynamics-spawn.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

vi.mock("../../runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
}));

vi.mock("../registry/subagent-registry-state.js", { spy: true });

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
let stateDir = "";

async function writeConfig(sandboxMode: "off" | "all"): Promise<void> {
  await writeFile(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify({
      session: { mainKey: "main", scope: "per-sender" },
      tools: { swarm: { enabled: true, maxConcurrent: 2 } },
      agents: {
        defaults: {
          workspace: stateDir,
          sandbox: { mode: sandboxMode },
        },
        entries: { main: { workspace: stateDir } },
      },
    })}\n`,
  );
  clearRuntimeConfigSnapshot();
  clearConfigCache();
}

function preparedVerifier() {
  return prepareDynamicsSpawn({
    task: "Verify the frozen candidate against the acceptance criteria.",
    dynamics: {
      boundary: "artifact-only",
      requirements: {
        sandbox: "require",
        candidateDigest: "required",
        artifactRefs: "required",
      },
      handoff: {
        candidateDigest: "sha256:candidate",
        artifactRefs: ["artifact://candidate"],
        evidenceRefs: ["evidence://builder-private-notes"],
        summary: "builder-private-rationale",
      },
      candidate: {
        version: 1,
        candidateDigest: "sha256:candidate",
        sourceDigest: "sha256:source",
        recipeDigest: "sha256:recipe",
        policyDigest: "sha256:policy",
      },
    },
    sourceReplicaId: "swarm:agent:main:main:parent-run",
    targetReplicaId: "code-run:bridge:1",
  });
}

async function launchPreparedVerifier() {
  const prepared = preparedVerifier();
  const input = {
    ...prepared,
    collect: true,
    groupId: "swarm:agent:main:main:parent-run",
  };
  const fingerprint = `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
  return await spawnSubagentDirect(
    {
      ...input,
      swarmLaunchReplayKey: "code-run:bridge:1",
      swarmLaunchRequestFingerprint: fingerprint,
    },
    {
      agentSessionKey: "agent:main:main",
      requesterRunId: "parent-run",
    },
  );
}

function installInProcessRegistryPersistenceForTests(): void {
  const persist = vi.mocked(registryState.persistSubagentRunsToDiskOrThrow);
  const persistAsync = vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow);
  persistAsync.mockReset().mockImplementation(async (runs, ids, options) => {
    const snapshot = structuredClone(runs);
    await Promise.resolve();
    let committed = false;
    try {
      options.assertCurrent?.();
      persist(snapshot, ids);
      committed = true;
      options.onCommitted?.();
    } catch (error) {
      throw new SubagentRegistryWriteError(committed ? "committed" : "not-committed", error);
    }
  });
}

describe("native dynamics spawn boundary", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    // Queued subagent admission creates its task through the real registry; keep that
    // owner in-process so the suite never depends on a host SQLite broker.
    configureInMemoryTaskStoresForTests();
    installInProcessRegistryPersistenceForTests();
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dynamics-native-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
    await writeConfig("off");
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("carries verifier guidance through the real native spawn path when sandbox admission succeeds", async () => {
    await writeConfig("all");
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        requests.push({ method, params });
        // SAFETY: this fixture supplies the accepted Gateway response shape for the generic T.
        return { runId: "native-dynamics-run", status: "accepted" } as T;
      },
    });

    const result = await launchPreparedVerifier();

    expect(result).toMatchObject({ status: "accepted" });
    const launch = requests.find((request) => request.method === "agent");
    expect(launch).toBeDefined();
    expect(launch?.params.message).toEqual(expect.stringContaining('"boundary":"artifact-only"'));
    expect(launch?.params.message).toEqual(expect.stringContaining("sha256:candidate"));
    expect(launch?.params.message).toEqual(expect.stringContaining("sha256:source"));
    expect(launch?.params.message).toEqual(expect.stringContaining("sha256:recipe"));
    expect(launch?.params.message).toEqual(expect.stringContaining("sha256:policy"));
    expect(launch?.params.message).toEqual(expect.stringContaining('"sandbox":"require"'));
    // Prove filtering at the native child-dispatch boundary, not merely in a helper.
    expect(launch?.params.message).toEqual(expect.stringContaining("artifact://candidate"));
    expect(launch?.params.message).not.toEqual(
      expect.stringContaining("evidence://builder-private-notes"),
    );
    expect(launch?.params.message).not.toEqual(
      expect.stringContaining("builder-private-rationale"),
    );
  });

  it("fails closed before native dispatch when a verifier requires an unavailable sandbox", async () => {
    const dispatchGatewayMethodInProcess = vi.fn(async () => {
      throw new Error("sandbox-required verifier must not dispatch unsandboxed");
    });
    subagentSpawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      dispatchGatewayMethodInProcess,
    });

    const result = await launchPreparedVerifier();

    expect(result.status).toBe("forbidden");
    expect(result.error).toEqual(expect.stringContaining("sandbox"));
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });
});
