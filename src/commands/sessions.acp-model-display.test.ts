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
type SessionRow = ReturnType<typeof acpRow> & { agentId: string };
afterEach(clearRuntimeConfigSnapshot);
const acpRow = (agentId: string) => ({
  model: `${agentId}-acp`,
  modelProvider: "acpx",
  acpRuntime: true,
  agentRuntime: { id: agentId, source: "session-key" },
});

it("keeps each selected owner's metadata and rejects a replaced lifecycle", () =>
  withOpenClawTestState({ label: "acp-sessions", layout: "state-only" }, async (state) => {
    setRuntimeConfigSnapshot(cfg);
    const owners = ["copilot", "reviewer"].map((agentId) => ({
      agentId,
      sessionKey: `agent:${agentId}:acp:current-session`,
      storePath: path.join(state.agentDir(agentId), "openclaw-agent.sqlite"),
    }));
    const writeSession = (owner: (typeof owners)[number], sessionId = `${owner.agentId}-session`) =>
      replaceSessionEntrySync(owner, {
        sessionId,
        lifecycleRevision: `${sessionId}-revision`,
        updatedAt: Date.now() - 240_000,
      });
    const readSessions = async () => {
      const { runtime, logs } = createCapturingTestRuntime();
      runtime.error = runtime.exit = (value: unknown) => {
        throw new Error(`Unexpected runtime failure: ${String(value)}`);
      };
      await sessionsCommand({ json: true, allAgents: true }, runtime);
      return (JSON.parse(logs.join("\n")) as { sessions: SessionRow[] }).sessions;
    };
    try {
      for (const owner of owners) {
        writeSession(owner);
        await upsertAcpSessionMeta({
          ...owner,
          cfg,
          mutate: () => ({
            backend: owner.agentId,
            agent: owner.agentId,
            runtimeSessionName: `${owner.agentId}-runtime-session`,
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          }),
        });
      }
      const before = await readSessions();
      for (const { agentId } of owners) {
        expect(before.find((row) => row.agentId === agentId)).toMatchObject(acpRow(agentId));
      }
      writeSession(owners[1]!, "reviewer-replacement");
      const after = await readSessions();
      expect(after.find((row) => row.agentId === "copilot")).toMatchObject(acpRow("copilot"));
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
        owners.map((owner) =>
          enforceSqliteSessionHistoryDiskBudget({ ...owner, mode: maintenance.mode, maintenance }),
        ),
      );
    }
  }));
