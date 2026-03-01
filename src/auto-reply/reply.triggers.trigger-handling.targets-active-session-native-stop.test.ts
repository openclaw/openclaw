import fs from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import {
  getAbortEmbeddedPiRunMock,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";
import { enqueueFollowupRun, getFollowupQueueDepth, type FollowupRun } from "./reply/queue.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
let previousFastTestEnv: string | undefined;
beforeAll(async () => {
  previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  ({ getReplyFromConfig } = await import("./reply.js"));
});
afterAll(() => {
  if (previousFastTestEnv === undefined) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("targets the active session for native /stop", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const storePath = cfg.session?.store;
      if (!storePath) {
        throw new Error("missing session store path");
      }
      const targetSessionKey = "agent:main:telegram:group:123";
      const targetSessionId = "session-target";
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [targetSessionKey]: {
            sessionId: targetSessionId,
            updatedAt: Date.now(),
          },
        }),
      );
      const followupRun: FollowupRun = {
        prompt: "queued",
        enqueuedAt: Date.now(),
        run: {
          agentId: "main",
          agentDir: join(home, "agent"),
          sessionId: targetSessionId,
          sessionKey: targetSessionKey,
          messageProvider: "telegram",
          agentAccountId: "acct",
          sessionFile: join(home, "session.jsonl"),
          workspaceDir: join(home, "workspace"),
          config: cfg,
          provider: "anthropic",
          model: "claude-opus-4-5",
          timeoutMs: 10,
          blockReplyBreak: "text_end",
        },
      };
      enqueueFollowupRun(
        targetSessionKey,
        followupRun,
        { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
        "none",
      );
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(1);

      const res = await getReplyFromConfig(
        {
          Body: "/stop",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("⚙️ Agent was aborted.");
      expect(getAbortEmbeddedPiRunMock()).toHaveBeenCalledWith(targetSessionId);
      const store = loadSessionStore(storePath);
      expect(store[targetSessionKey]?.abortedLastRun).toBe(true);
      expect(getFollowupQueueDepth(targetSessionKey)).toBe(0);
    });
  });
  it("applies native /model to the target session", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      const storePath = cfg.session?.store;
      if (!storePath) {
        throw new Error("missing session store path");
      }
      const slashSessionKey = "telegram:slash:111";
      const targetSessionKey = MAIN_SESSION_KEY;

      // Seed the target session to ensure the native command mutates it.
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [targetSessionKey]: {
            sessionId: "session-target",
            updatedAt: Date.now(),
          },
        }),
      );

      const res = await getReplyFromConfig(
        {
          Body: "/model openai/gpt-4.1-mini",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: slashSessionKey,
          CommandSource: "native",
          CommandTargetSessionKey: targetSessionKey,
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Model set to openai/gpt-4.1-mini");

      const store = loadSessionStore(storePath);
      expect(store[targetSessionKey]?.providerOverride).toBe("openai");
      expect(store[targetSessionKey]?.modelOverride).toBe("gpt-4.1-mini");
      expect(store[slashSessionKey]).toBeUndefined();

      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hi",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
        },
        {},
        cfg,
      );

      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      expect(getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-4.1-mini",
        }),
      );
    });
  });

  it("uses the target agent model for native /status", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home) as unknown as OpenClawConfig;
      cfg.agents = {
        ...cfg.agents,
        list: [{ id: "coding", model: "minimax/MiniMax-M2.1" }],
      };
      cfg.channels = {
        ...cfg.channels,
        telegram: {
          allowFrom: ["*"],
        },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/status",
          From: "telegram:111",
          To: "telegram:111",
          ChatType: "group",
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "telegram:slash:111",
          CommandSource: "native",
          CommandTargetSessionKey: "agent:coding:telegram:group:123",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("minimax/MiniMax-M2.1");
    });
  });
});
