import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
    ...overrides,
  };
}

function mockAgentPayloads(payloads: Array<Record<string, unknown>>): void {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

describe("runCronIsolatedAgentTurn – channel 'last' resolution", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("delivers via fallback when channel 'last' has no session history", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastProvider: "webchat",
        lastTo: "",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { telegram: { botToken: "t-1" } },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
    });
  });

  it("delivers via fallback when channel 'last' has no session history (best-effort)", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastProvider: "webchat",
        lastTo: "",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { telegram: { botToken: "t-1" } },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "last", bestEffort: true },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
    });
  });

  it("falls back to configured channel when channel 'last' resolves to unconfigured channel", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastChannel: "whatsapp",
        lastTo: "5551234",
        lastProvider: "whatsapp",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { telegram: { botToken: "t-1" } },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
    });
  });

  it("falls back to configured channel when channel 'last' resolves to unconfigured channel (best-effort)", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastChannel: "whatsapp",
        lastTo: "5551234",
        lastProvider: "whatsapp",
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);
      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { telegram: { botToken: "t-1" } },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "last", bestEffort: true },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
    });
  });
});
