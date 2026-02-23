import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSessionStore, resolveSessionKey } from "../config/sessions.js";
import {
  getCompactEmbeddedPiSessionMock,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";
import { HEARTBEAT_TOKEN } from "./tokens.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

const BASE_MESSAGE = {
  Body: "hello",
  From: "+1002",
  To: "+2000",
} as const;

function mockEmbeddedOkPayload() {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  return runEmbeddedPiAgentMock;
}

function requireSessionStorePath(cfg: { session?: { store?: string } }): string {
  const storePath = cfg.session?.store;
  if (!storePath) {
    throw new Error("expected session store path");
  }
  return storePath;
}

async function writeStoredModelOverride(cfg: ReturnType<typeof makeCfg>): Promise<void> {
  await fs.writeFile(
    requireSessionStorePath(cfg),
    JSON.stringify({
      [MAIN_SESSION_KEY]: {
        sessionId: "main",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.2",
      },
    }),
    "utf-8",
  );
}

function mockSuccessfulCompaction() {
  getCompactEmbeddedPiSessionMock().mockResolvedValue({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "x",
      tokensBefore: 12000,
    },
  });
}

function replyText(res: Awaited<ReturnType<typeof getReplyFromConfig>>) {
  return Array.isArray(res) ? res[0]?.text : res?.text;
}

describe("trigger handling", () => {
  it("includes the error cause when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockRejectedValue(new Error("sandbox is not defined."));

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Agent failed before reply: sandbox is not defined.\nLogs: openclaw logs --follow",
      );
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    });
  });

  it("uses heartbeat model override for heartbeat runs", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockEmbeddedOkPayload();
      const cfg = makeCfg(home);
      await writeStoredModelOverride(cfg);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { model: "anthropic/claude-haiku-4-5-20251001" },
        },
      };

      await getReplyFromConfig(BASE_MESSAGE, { isHeartbeat: true }, cfg);

      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-haiku-4-5-20251001");
    });
  });

  it("keeps stored model override for heartbeat runs when heartbeat model is not configured", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockEmbeddedOkPayload();
      const cfg = makeCfg(home);
      await writeStoredModelOverride(cfg);
      await getReplyFromConfig(BASE_MESSAGE, { isHeartbeat: true }, cfg);

      const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-5.2");
    });
  });

  it("suppresses HEARTBEAT_OK replies outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: HEARTBEAT_TOKEN }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));

      expect(res).toBeUndefined();
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    });
  });

  it("strips HEARTBEAT_OK at edges outside heartbeat runs", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: `${HEARTBEAT_TOKEN} hello` }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(BASE_MESSAGE, {}, makeCfg(home));

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
    });
  });

  it("updates group activation when the owner sends /activation", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "/activation always",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+2000",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Group activation set to always");
      const store = JSON.parse(await fs.readFile(requireSessionStorePath(cfg), "utf-8")) as Record<
        string,
        { groupActivation?: string }
      >;
      expect(store["agent:main:whatsapp:group:123@g.us"]?.groupActivation).toBe("always");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("runs /compact as a gated command", async () => {
    await withTempHome(async (home) => {
      const storePath = join(tmpdir(), `openclaw-session-test-${Date.now()}.json`);
      const cfg = makeCfg(home);
      cfg.session = { ...cfg.session, store: storePath };
      mockSuccessfulCompaction();

      const res = await getReplyFromConfig(
        {
          Body: "/compact focus on decisions",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = replyText(res);
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(getCompactEmbeddedPiSessionMock()).toHaveBeenCalledOnce();
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
      const store = loadSessionStore(storePath);
      const sessionKey = resolveSessionKey("per-sender", {
        Body: "/compact focus on decisions",
        From: "+1003",
        To: "+2000",
      });
      expect(store[sessionKey]?.compactionCount).toBe(1);
    });
  });

  it("runs /compact for non-default agents without transcript path validation failures", async () => {
    await withTempHome(async (home) => {
      getCompactEmbeddedPiSessionMock().mockClear();
      mockSuccessfulCompaction();

      const res = await getReplyFromConfig(
        {
          Body: "/compact",
          From: "+1004",
          To: "+2000",
          SessionKey: "agent:worker1:telegram:12345",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );

      const text = replyText(res);
      expect(text?.startsWith("⚙️ Compacted")).toBe(true);
      expect(getCompactEmbeddedPiSessionMock()).toHaveBeenCalledOnce();
      expect(getCompactEmbeddedPiSessionMock().mock.calls[0]?.[0]?.sessionFile).toContain(
        join("agents", "worker1", "sessions"),
      );
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });

  it("ignores think directives that only appear in the context wrapper", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      const res = await getReplyFromConfig(
        {
          Body: [
            "[Chat messages since your last reply - for context]",
            "Peter: /thinking high [2025-12-05T21:45:00.000Z]",
            "",
            "[Current message - respond to this]",
            "Give me the status",
          ].join("\n"),
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = replyText(res);
      expect(text).toBe("ok");
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const prompt = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("Give me the status");
      expect(prompt).not.toContain("/thinking high");
      expect(prompt).not.toContain("/think high");
    });
  });

  it("does not emit directive acks for heartbeats with /think", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      const res = await getReplyFromConfig(
        {
          Body: "HEARTBEAT /think:high",
          From: "+1003",
          To: "+1003",
        },
        { isHeartbeat: true },
        makeCfg(home),
      );

      const text = replyText(res);
      expect(text).toBe("ok");
      expect(text).not.toMatch(/Thinking level set/i);
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
    });
  });
});
