import { StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { SystemAgentChatParams } from "../../../packages/gateway-protocol/src/index.js";
import { createSqliteAuditRecordStore } from "../../infra/sqlite-audit-record-store.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import * as stateReader from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../../state/openclaw-state-db.js";
import type { SystemAgentOverview } from "../../system-agent/overview.js";
import { readTranscriptTailAsync } from "../../system-agent/transcript-store.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient } from "./types.js";

const overview: SystemAgentOverview = {
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: "hash" },
  agents: [{ id: "main", name: "Main", isDefault: true, model: "openai/gpt-5.5" }],
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  tools: {
    codex: { command: "codex", found: false },
    claude: { command: "claude", found: false },
    gemini: { command: "gemini", found: false },
    apiKeys: { openai: false, anthropic: false },
  },
  gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
  references: { docsUrl: "https://docs.test", sourceUrl: "https://source.test" },
};

const engines = vi.hoisted(() => [] as Array<ReturnType<typeof makeEngine>>);

function makeEngine() {
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  return {
    handle: vi.fn(async (message: string) => {
      history.push({ role: "user", text: message }, { role: "assistant", text: "Recorded answer" });
      return { text: "Recorded answer", action: "none" };
    }),
    seedHistory: vi.fn((turns: typeof history) => history.push(...turns)),
    historyLength: () => history.length,
    historySince: (index: number) => history.slice(index),
    noteAssistantMessage: (text: string) => history.push({ role: "assistant", text }),
    dispose: vi.fn(async () => undefined),
    loadOverview: async () => overview,
    planGreeting: vi.fn(async () => ({ text: "I'm OpenClaw.", modelRef: "openai/gpt-5.5" })),
  };
}

// mock-isolation: Exercise real audit persistence with deterministic history instead of provider inference.
vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: ReturnType<typeof makeEngine>) {
    const engine = makeEngine();
    engines.push(engine);
    Object.assign(this, engine);
  },
}));
// mock-isolation: Supply synthetic inference readiness without reading provider credentials.
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: async () => ({ ok: true, binding: {} }),
}));
vi.mock("../server/health-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/health-state.js")>()),
  getHealthCache: () => null,
}));
vi.mock("../../infra/update-status-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-status-state.js")>()),
  getUpdateAvailable: () => null,
}));

const client = {
  connId: "audit-worker-client",
  connect: { device: { id: "audit-worker-device" } },
} as GatewayClient;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  engines.length = 0;
  resetCommandQueueStateForTest();
});

async function withAuditState(
  run: (store: ReturnType<typeof createSqliteAuditRecordStore>) => Promise<void>,
) {
  await withTestDir({ prefix: "system-agent-audit-worker-" }, async (stateDir) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await run(
        createSqliteAuditRecordStore({ scope: "system-agent-transcript", maxEntries: 1_000 }),
      );
    } finally {
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function chatRequest(current?: () => boolean) {
  const sessions = new Map<string, SystemAgentChatSession>();
  const respond = vi.fn();
  const chat = (params: SystemAgentChatParams) =>
    expectDefined(
      systemAgentHandlers["openclaw.chat"],
      "chat handler",
    )({
      params,
      client,
      context: { systemAgentSessions: sessions },
      respond,
      ...(current ? { hasCurrentClientAuthority: current } : {}),
    } as never);
  return { chat, respond, sessions };
}

it("persists real chat, greeting, and reset flows through the audit owner", async () => {
  await withAuditState(async (transcript) => {
    transcript.upsert("seed", { role: "user", text: "Earlier question", at: 1 }, 1);
    const { chat, respond } = chatRequest();
    const callChat = async (params: SystemAgentChatParams) => {
      await chat(params);
      expect(respond).toHaveBeenLastCalledWith(true, expect.any(Object), undefined);
    };

    const sql: string[] = [];
    (["get", "all", "run", "iterate"] as const).forEach((method) => {
      const original = StatementSync.prototype[method];
      vi.spyOn(StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, receiver: StatementSync, args) {
            if (/\bdiagnostic_events\b/.test(receiver.sourceSQL)) {
              sql.push(receiver.sourceSQL);
            }
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    });
    await callChat({ sessionId: "conversation", message: "Record this turn" });
    expect(engines[0]?.seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "Earlier question" },
    ]);
    await callChat({ sessionId: "welcome" });
    expect(engines[1]?.planGreeting).toHaveBeenCalledOnce();
    await callChat({ sessionId: "cached-welcome" });
    expect(engines[2]?.planGreeting).not.toHaveBeenCalled();
    await callChat({ sessionId: "conversation", reset: true });
    expect(engines[0]?.dispose).toHaveBeenCalledOnce();
    expect(engines[3]?.seedHistory).not.toHaveBeenCalled();
    const persisted = await readTranscriptTailAsync(30);
    expect(persisted.map(({ text }) => text)).toEqual([
      "Earlier question",
      expect.any(String),
      "Record this turn",
      "Recorded answer",
    ]);
    expect(await readTranscriptTailAsync(30, { afterLastReset: true })).toEqual([]);
    expect(sql).toEqual([]);
  });
});

it.each(["failed", "revoked"] as const)(
  "disposes the unseeded engine after %s worker history",
  async (outcome) => {
    await withAuditState(async (store) => {
      store.upsert("private", { role: "assistant", text: "Private history", at: 1 }, 1);
      expect(await readTranscriptTailAsync(10)).toEqual([
        { role: "assistant", text: "Private history", at: 1 },
      ]);
      let current = true;
      if (outcome === "failed") {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE diagnostic_events SET payload_json = ? WHERE scope = ?")
          .run("invalid-json", "system-agent-transcript");
      } else {
        const read = stateReader.executeExistingOpenClawStateRead;
        vi.spyOn(stateReader, "executeExistingOpenClawStateRead").mockImplementation(
          async (...args) => {
            const result = await read(...args);
            if (args[1].type === "diagnostic.latest") {
              current = false;
            }
            return result;
          },
        );
      }
      const { chat, respond, sessions } = chatRequest(() => current);
      const reading = chat({ sessionId: "refused-seed" });
      await expect(reading).rejects.toThrow(
        outcome === "revoked" ? "Gateway requester authority changed" : /JSON|Unexpected token/,
      );
      expect(respond).not.toHaveBeenCalled();
      expect(sessions.size).toBe(0);
      expect(engines[0]?.seedHistory).not.toHaveBeenCalled();
      expect(engines[0]?.dispose).toHaveBeenCalledOnce();
    });
  },
);
