import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as configModule from "../config/config.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-diag-" });
}

function mockConfig(
  home: string,
  storePath: string,
  overrides?: {
    diagnostics?: boolean;
    agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>;
  },
) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "anthropic/claude-opus-4-5": {} },
        workspace: path.join(home, "openclaw"),
        ...overrides?.agentOverrides,
      },
    },
    session: { store: storePath, mainKey: "main" },
    diagnostics: overrides?.diagnostics ? { enabled: true } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDiagnosticEventsForTest();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: {
        sessionId: "s",
        provider: "anthropic",
        model: "claude-opus-4-5",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
      },
    },
  });
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
});

describe("agentCommand – diagnostic events", () => {
  it("emits message.queued when diagnostics are enabled", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555" }, runtime);
      unsub();

      const queued = events.filter((e) => e.type === "message.queued");
      expect(queued).toHaveLength(1);
      expect(queued[0].source).toBe("agent-command");
      expect(queued[0].sessionKey).toBeTruthy();
      expect(queued[0].sessionId).toBeTruthy();
    });
  });

  it("emits run.completed on successful run", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555" }, runtime);
      unsub();

      const completed = events.filter((e) => e.type === "run.completed");
      expect(completed).toHaveLength(1);

      const evt = completed[0];
      expect(evt.runId).toBeTruthy();
      expect(evt.sessionKey).toBeTruthy();
      expect(evt.provider).toBe("anthropic");
      expect(evt.model).toBe("claude-opus-4-5");
      expect(evt.operationName).toBe("chat");
      expect(evt.durationMs).toBeTypeOf("number");
      expect(evt.durationMs).toBeGreaterThanOrEqual(0);
      expect(evt.usage).toEqual(
        expect.objectContaining({
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          total: 18,
        }),
      );
      expect(evt.error).toBeUndefined();
    });
  });

  it("emits run.completed with error info when run throws", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      vi.mocked(runEmbeddedPiAgent).mockRejectedValueOnce(new Error("model overloaded"));

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await expect(agentCommand({ message: "hello", to: "+1555" }, runtime)).rejects.toThrow(
        "model overloaded",
      );
      unsub();

      const completed = events.filter((e) => e.type === "run.completed");
      expect(completed).toHaveLength(1);

      const evt = completed[0];
      expect(evt.error).toContain("model overloaded");
      expect(evt.errorType).toBe("exception");
      expect(evt.durationMs).toBeTypeOf("number");
    });
  });

  it("emits message.processed on successful run", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555" }, runtime);
      unsub();

      const processed = events.filter((e) => e.type === "message.processed");
      expect(processed).toHaveLength(1);

      const evt = processed[0];
      expect(evt.sessionKey).toBeTruthy();
      expect(evt.sessionId).toBeTruthy();
      expect(evt.outcome).toBe("completed");
      expect(evt.durationMs).toBeTypeOf("number");
      expect(evt.durationMs).toBeGreaterThanOrEqual(0);
      expect(evt.error).toBeUndefined();
    });
  });

  it("emits message.processed with error outcome when run throws", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      vi.mocked(runEmbeddedPiAgent).mockRejectedValueOnce(new Error("timeout"));

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await expect(agentCommand({ message: "hello", to: "+1555" }, runtime)).rejects.toThrow(
        "timeout",
      );
      unsub();

      const processed = events.filter((e) => e.type === "message.processed");
      expect(processed).toHaveLength(1);

      const evt = processed[0];
      expect(evt.outcome).toBe("error");
      expect(evt.error).toContain("timeout");
    });
  });

  it("emits full diagnostic event sequence in correct order", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555" }, runtime);
      unsub();

      const types = events.map((e) => e.type);
      const queuedIdx = types.indexOf("message.queued");
      const completedIdx = types.indexOf("run.completed");
      const processedIdx = types.indexOf("message.processed");

      expect(queuedIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeGreaterThanOrEqual(0);
      expect(processedIdx).toBeGreaterThanOrEqual(0);

      // message.queued must come before run.completed
      expect(queuedIdx).toBeLessThan(completedIdx);
      // run.completed must come before message.processed
      expect(completedIdx).toBeLessThan(processedIdx);
    });
  });

  it("does not emit diagnostic events when diagnostics are disabled", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: false });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555" }, runtime);
      unsub();

      const diagTypes = new Set(["message.queued", "run.completed", "message.processed"]);
      const matched = events.filter((e) => diagTypes.has(e.type));
      expect(matched).toHaveLength(0);
    });
  });

  it("uses replyChannel for diagnostic event channel field", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { diagnostics: true });

      const events: DiagnosticEventPayload[] = [];
      const unsub = onDiagnosticEvent((evt) => events.push(evt));

      await agentCommand({ message: "hello", to: "+1555", replyChannel: "slack" }, runtime);
      unsub();

      const queued = events.find((e) => e.type === "message.queued");
      expect(queued?.channel).toBe("slack");

      const completed = events.find((e) => e.type === "run.completed");
      expect(completed?.channel).toBe("slack");
    });
  });
});
