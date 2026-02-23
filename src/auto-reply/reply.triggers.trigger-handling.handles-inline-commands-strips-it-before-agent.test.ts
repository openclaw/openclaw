import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  expectInlineCommandHandledAndStripped,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  MAIN_SESSION_KEY,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  getReplyFromConfig = await loadGetReplyFromConfig();
});

installTriggerHandlingE2eTestHooks();

function makeUnauthorizedWhatsAppCfg(home: string) {
  const baseCfg = makeCfg(home);
  return {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        allowFrom: ["+1000"],
      },
    },
  };
}

function requireSessionStorePath(cfg: { session?: { store?: string } }): string {
  const storePath = cfg.session?.store;
  if (!storePath) {
    throw new Error("expected session store path");
  }
  return storePath;
}

async function expectUnauthorizedCommandDropped(home: string, body: "/status" | "/whoami") {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  const cfg = makeUnauthorizedWhatsAppCfg(home);

  const res = await getReplyFromConfig(
    {
      Body: body,
      From: "+2001",
      To: "+2000",
      Provider: "whatsapp",
      SenderE164: "+2001",
    },
    {},
    cfg,
  );

  expect(res).toBeUndefined();
  expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
}

function mockEmbeddedOk() {
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

async function runInlineUnauthorizedCommand(params: {
  home: string;
  command: "/status" | "/help";
}) {
  const cfg = makeUnauthorizedWhatsAppCfg(params.home);
  const res = await getReplyFromConfig(
    {
      Body: `please ${params.command} now`,
      From: "+2001",
      To: "+2000",
      Provider: "whatsapp",
      SenderE164: "+2001",
    },
    {},
    cfg,
  );
  return res;
}

describe("trigger handling", () => {
  it("handles inline /commands and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      await expectInlineCommandHandledAndStripped({
        home,
        getReplyFromConfig,
        body: "please /commands now",
        stripToken: "/commands",
        blockReplyContains: "Slash commands",
      });
    });
  });

  it("handles inline /whoami and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      await expectInlineCommandHandledAndStripped({
        home,
        getReplyFromConfig,
        body: "please /whoami now",
        stripToken: "/whoami",
        blockReplyContains: "Identity",
        requestOverrides: {
          SenderId: "12345",
        },
      });
    });
  });

  it("handles inline /help and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      await expectInlineCommandHandledAndStripped({
        home,
        getReplyFromConfig,
        body: "please /help now",
        stripToken: "/help",
        blockReplyContains: "Help",
      });
    });
  });

  it("drops /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      await expectUnauthorizedCommandDropped(home, "/status");
    });
  });

  it("drops /whoami for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      await expectUnauthorizedCommandDropped(home, "/whoami");
    });
  });

  it("keeps inline /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockEmbeddedOk();
      const res = await runInlineUnauthorizedCommand({
        home,
        command: "/status",
      });
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("/status");
    });
  });

  it("keeps inline /help for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockEmbeddedOk();
      const res = await runInlineUnauthorizedCommand({
        home,
        command: "/help",
      });
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("/help");
    });
  });

  it("returns help without invoking the agent", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      const res = await getReplyFromConfig(
        {
          Body: "/help",
          From: "+1002",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        makeCfg(home),
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Help");
      expect(text).toContain("Session");
      expect(text).toContain("More: /commands for full list");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });

  it("allows owner to set send policy", async () => {
    await withTempHome(async (home) => {
      const cfg = makeUnauthorizedWhatsAppCfg(home);

      const res = await getReplyFromConfig(
        {
          Body: "/send off",
          From: "+1000",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Send policy set to off");

      const storeRaw = await fs.readFile(requireSessionStorePath(cfg), "utf-8");
      const store = JSON.parse(storeRaw) as Record<string, { sendPolicy?: string }>;
      expect(store[MAIN_SESSION_KEY]?.sendPolicy).toBe("deny");
    });
  });
});
