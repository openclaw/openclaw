import "./subagent-spawn-model.mocks.shared.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../config/config.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../registry/subagent-registry.test-helpers.js";
import { prepareDynamicsSpawn } from "../swarm/dynamics/dynamics-spawn.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

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
      profile: "independent-verifier",
      handoff: {
        candidateDigest: "sha256:candidate",
        artifactRefs: ["artifact://candidate"],
      },
    },
    sourceReplicaId: "swarm:agent:main:main:parent-run",
    targetReplicaId: "code-run:bridge:1",
  });
}

async function launchPreparedVerifier() {
  const prepared = preparedVerifier();
  return await spawnSubagentDirect(
    {
      ...prepared,
      collect: true,
      groupId: "swarm:agent:main:main:parent-run",
      swarmLaunchReplayKey: "code-run:bridge:1",
      swarmLaunchRequestFingerprint:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    {
      agentSessionKey: "agent:main:main",
      requesterRunId: "parent-run",
    },
  );
}

describe("native dynamics spawn boundary", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
    });

    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dynamics-native-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await writeConfig("off");
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
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

  it(
    "carries verifier guidance through the real native spawn path when sandbox admission succeeds",
    async () => {
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
      expect(launch?.params.message).toEqual(expect.stringContaining("independent-verifier"));
      expect(launch?.params.message).toEqual(expect.stringContaining("sha256:candidate"));
      expect(launch?.params.message).toEqual(
        expect.stringContaining("Check the referenced candidate without changing it"),
      );
    },
  );

  it(
    "fails closed before native dispatch when a verifier requires an unavailable sandbox",
    async () => {
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
    },
  );
});
