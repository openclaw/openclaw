import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { enforceSqliteSessionHistoryDiskBudget } from "../config/sessions/session-history-eviction.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionsCommand } from "./sessions.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const model = "gpt-5.3-codex";
const modelProvider = "microsoft-foundry";
const modelRef = `${modelProvider}/${model}`;
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { copilot: {}, reviewer: {} },
    defaults: {
      model: { primary: modelRef },
      models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
    },
  },
};
type SessionRow = {
  agentId: string;
  model: string;
  modelProvider: string;
  acpRuntime: boolean;
  agentRuntime: { id: string; source: string };
};
afterEach(clearRuntimeConfigSnapshot);

it("keeps each selected owner's metadata and rejects a replaced lifecycle", async () => {
  await withOpenClawTestState({ label: "acp-sessions", layout: "state-only" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const stores = new Map<string, string>();
    const sessionKey = (id: string) => `agent:${id}:acp:current-session`;
    const writeSession = (agentId: string, sessionId = `${agentId}-session`) => {
      const storePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
      stores.set(agentId, storePath);
      replaceSessionEntrySync(
        { agentId, sessionKey: sessionKey(agentId), storePath },
        { sessionId, lifecycleRevision: `${sessionId}-revision`, updatedAt: Date.now() - 240_000 },
      );
    };
    const readSessions = async () => {
      const { runtime, logs } = createCapturingTestRuntime();
      runtime.error = (message) => {
        throw new Error(String(message));
      };
      runtime.exit = (code) => {
        throw new Error(`Unexpected exit ${code}`);
      };
      await sessionsCommand({ json: true, allAgents: true }, runtime);
      return (JSON.parse(logs.join("\n")) as { sessions: SessionRow[] }).sessions;
    };
    try {
      for (const agentId of ["copilot", "reviewer"]) {
        writeSession(agentId);
        await upsertAcpSessionMeta({
          cfg,
          agentId,
          sessionKey: sessionKey(agentId),
          mutate: () => ({
            backend: agentId,
            agent: agentId,
            runtimeSessionName: `${agentId}-runtime-session`,
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          }),
        });
      }
      const before = await readSessions();
      for (const agentId of ["copilot", "reviewer"]) {
        expect(before.find((row) => row.agentId === agentId)).toMatchObject({
          model: `${agentId}-acp`,
          modelProvider: "acpx",
          acpRuntime: true,
          agentRuntime: { id: agentId, source: "session-key" },
        });
      }
      writeSession("reviewer", "reviewer-replacement");
      const after = await readSessions();
      expect(after.find((row) => row.agentId === "copilot")).toMatchObject({
        acpRuntime: true,
        agentRuntime: { id: "copilot", source: "session-key" },
      });
      expect(after.find((row) => row.agentId === "reviewer")).toMatchObject({
        model,
        modelProvider,
        acpRuntime: false,
        agentRuntime: { id: "openclaw", source: "model" },
      });
    } finally {
      // Join native ACP maintenance before the shared fixture closes databases and restores env.
      const maintenance = resolveMaintenanceConfig();
      await Promise.all(
        [...stores].map(([agentId, storePath]) =>
          enforceSqliteSessionHistoryDiskBudget({
            agentId,
            storePath,
            mode: maintenance.mode,
            maintenance,
          }),
        ),
      );
    }
  });
});
