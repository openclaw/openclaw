import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTempHome } from "../plugin-sdk/test-env.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createOwnershipHarness,
  createOwnershipRegistry,
  createOwnershipSubagent,
} from "./registry-ownership.test-support.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { PluginRuntime } from "./runtime/types.js";

function createHarnessCaller(runtime: PluginRuntime, config: OpenClawConfig, callerId: string) {
  const { createApi } = createOwnershipRegistry(runtime, config);
  const { api: caller } = createApi(callerId);
  createApi("harness-owner").api.registerAgentHarness(
    createOwnershipHarness("test-harness", { label: "Test Harness" }),
  );
  return caller;
}

function lockedEntry(sessionId: string, updatedAt: number) {
  return { sessionId, updatedAt, agentHarnessId: "test-harness", modelSelectionLocked: true };
}

describe("plugin registry SQLite session ownership", () => {
  it("resolves unscoped worker keys through the configured default agent", async () => {
    await withTempHome(async () => {
      const config: OpenClawConfig = {
        agents: { entries: { researcher: {} } },
      };
      setRuntimeConfigSnapshot(config);
      onTestFinished(clearRuntimeConfigSnapshot);
      const subagent = createOwnershipSubagent("workboard-run");
      const runtime = createPluginRuntime({ subagent });
      let runtimeConfig = config;
      runtime.config = { ...runtime.config, current: () => runtimeConfig };
      const api = createHarnessCaller(runtime, config, "workboard");

      try {
        const sessionKey = "subagent:workboard-default-unassigned";
        await expect(api.runtime.subagent.run({ sessionKey, message: "start" })).resolves.toEqual({
          runId: "workboard-run",
        });
        expect(subagent.run).toHaveBeenCalledWith({ sessionKey, message: "start" });

        for (const invalidSessionKey of ["agent::malformed", "global", "unknown"]) {
          await expect(
            api.runtime.subagent.run({ sessionKey: invalidSessionKey, message: "reject" }),
          ).rejects.toThrow("Cannot resolve SQLite session scope without an agent id");
        }

        const lockedSessionKey = "harness:test-harness:owned";
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: `agent:researcher:${lockedSessionKey}` },
          lockedEntry("owned-session", 1),
        );
        await expect(
          api.runtime.subagent.run({ sessionKey: lockedSessionKey, message: "continue" }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(subagent.run).toHaveBeenCalledOnce();

        await replaceSessionEntry(
          { agentId: "replacement", sessionKey: `agent:replacement:${sessionKey}` },
          lockedEntry("replacement-owned-session", 2),
        );
        const pending = api.runtime.subagent.run({ sessionKey, message: "continue" });
        runtimeConfig = { agents: { entries: { replacement: {} } } };
        setRuntimeConfigSnapshot(runtimeConfig);
        await expect(pending).rejects.toThrow('owned by plugin "harness-owner"');
        expect(subagent.run).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });

  it("keeps embedded incognito ID scans in the key's agent store", async () => {
    await withTempHome(async (home) => {
      setRuntimeConfigSnapshot({});
      onTestFinished(clearRuntimeConfigSnapshot);
      const sessionKey = "agent:researcher:dashboard:incognito-ownership-check";
      const sessionId = "incognito-session";
      const lockedKey = "agent:researcher:dashboard:incognito-locked-owner";
      const lockedSessionId = "locked-incognito-session";
      const memoryLocation = {
        agentId: "researcher",
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "researcher" }),
      };
      try {
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey },
          { sessionId, updatedAt: 1 },
        );
        await replaceSessionEntry(
          { agentId: "researcher", sessionKey: lockedKey },
          lockedEntry(lockedSessionId, 2),
        );

        const runtime = createPluginRuntime();
        const runEmbeddedAgent = vi.fn(async () => ({
          ok: true,
        })) as unknown as PluginRuntime["agent"]["runEmbeddedAgent"];
        Object.defineProperty(runtime.agent, "runEmbeddedAgent", {
          configurable: true,
          value: runEmbeddedAgent,
        });
        const callerApi = createHarnessCaller(runtime, {}, "extractor-plugin");
        const runParams = {
          sessionId,
          sessionKey,
          workspaceDir: path.join(home, "workspace"),
          prompt: "continue",
          timeoutMs: 1,
          runId: "run-1",
        } as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

        await expect(callerApi.runtime.agent.runEmbeddedAgent(runParams)).resolves.toEqual({
          ok: true,
        });
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({ ...runParams, agentId: "main" }),
        ).rejects.toThrow('does not match session key agent "researcher"');
        await expect(
          callerApi.runtime.agent.runEmbeddedAgent({
            ...runParams,
            sessionId: lockedSessionId,
          }),
        ).rejects.toThrow('owned by plugin "harness-owner"');
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(memorySessionActorOwners.read(memoryLocation)).toBeDefined();
      } finally {
        memorySessionActorOwners.closeDatabase(memoryLocation);
        closeOpenClawAgentDatabasesForTest();
      }
    });
  });
});
