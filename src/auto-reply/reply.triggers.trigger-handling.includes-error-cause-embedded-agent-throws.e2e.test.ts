import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeCfg,
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

async function writeStoredModelOverride(cfg: ReturnType<typeof makeCfg>): Promise<void> {
  await fs.writeFile(
    cfg.session.store,
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
      const store = JSON.parse(await fs.readFile(cfg.session.store, "utf-8")) as Record<
        string,
        { groupActivation?: string }
      >;
      expect(store["agent:main:whatsapp:group:123@g.us"]?.groupActivation).toBe("always");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
