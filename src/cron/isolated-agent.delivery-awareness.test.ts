import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway } from "../gateway/call.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

async function runAnnounceTurn(params: { home: string; storePath: string; sessionKey?: string }) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath),
    deps: createCliDeps(),
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
      },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn cron delivery awareness", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("injects delivered cron text back into the main session transcript", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "hello from cron" }]);

      const res = await runAnnounceTurn({ home, storePath });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:main",
            message: "hello from cron",
            label: "Cron delivery",
            idempotencyKey: expect.stringContaining("cron-awareness:v1:"),
          }),
        }),
      ]);
    });
  });

  it("uses the routed thread session when the cron job is bound to one", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
        "agent:main:main:thread:42": {
          sessionId: "thread-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "thread digest" }]);

      await runAnnounceTurn({
        home,
        storePath,
        sessionKey: "agent:main:main:thread:42",
      });

      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:main:thread:42",
            message: "thread digest",
          }),
        }),
      ]);
    });
  });
});
