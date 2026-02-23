import fs from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  expectInlineCommandHandledAndStripped,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  MAIN_SESSION_KEY,
  makeCfg,
  makeWhatsAppElevatedCfg,
  mockRunEmbeddedPiAgentOk,
  readSessionStore,
  requireSessionStorePath,
  runGreetingPromptForBareNewOrReset,
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

async function expectResetBlockedForNonOwner(params: { home: string }): Promise<void> {
  const { home } = params;
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockClear();
  const cfg = makeCfg(home);
  cfg.channels ??= {};
  cfg.channels.whatsapp = {
    ...cfg.channels.whatsapp,
    allowFrom: ["+1999"],
  };
  cfg.session = {
    ...cfg.session,
    store: join(home, "blocked-reset.sessions.json"),
  };
  const res = await getReplyFromConfig(
    {
      Body: "/reset",
      From: "+1003",
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    cfg,
  );
  expect(res).toBeUndefined();
  expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
}

async function expectUnauthorizedCommandDropped(home: string, body: "/status") {
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
  return mockRunEmbeddedPiAgentOk("ok");
}

async function runInlineUnauthorizedCommand(params: { home: string; command: "/status" }) {
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
  it("handles owner-admin commands without invoking the agent", async () => {
    await withTempHome(async (home) => {
      {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockClear();
        const cfg = makeCfg(home);
        const res = await getReplyFromConfig(
          {
            Body: "/activation mention",
            From: "123@g.us",
            To: "+2000",
            ChatType: "group",
            Provider: "whatsapp",
            SenderE164: "+999",
            CommandAuthorized: true,
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toBe("⚙️ Group activation set to mention.");
        expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
      }

      {
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockClear();
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
        expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
      }
    });
  });

  it("injects group activation context into the system prompt", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = makeCfg(home);
      cfg.channels ??= {};
      cfg.channels.whatsapp = {
        ...cfg.channels.whatsapp,
        allowFrom: ["*"],
        groups: { "*": { requireMention: false } },
      };
      cfg.messages = {
        ...cfg.messages,
        groupChat: {},
      };

      const res = await getReplyFromConfig(
        {
          Body: "hello group",
          From: "123@g.us",
          To: "+2000",
          ChatType: "group",
          Provider: "whatsapp",
          SenderE164: "+2000",
          GroupSubject: "Test Group",
          GroupMembers: "Alice (+1), Bob (+2)",
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const extra = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.extraSystemPrompt ?? "";
      expect(extra).toContain('"chat_type": "group"');
      expect(extra).toContain("Activation: always-on");
    });
  });

  it("runs a greeting prompt for bare /new and blocks unauthorized /reset", async () => {
    await withTempHome(async (home) => {
      await runGreetingPromptForBareNewOrReset({ home, body: "/new", getReplyFromConfig });
      await expectResetBlockedForNonOwner({ home });
    });
  });

  it("handles inline commands and strips directives before the agent", async () => {
    await withTempHome(async (home) => {
      await expectInlineCommandHandledAndStripped({
        home,
        getReplyFromConfig,
        body: "please /whoami now",
        stripToken: "/whoami",
        blockReplyContains: "Identity",
        requestOverrides: { SenderId: "12345" },
      });
    });
  });

  it("enforces top-level command auth while keeping inline text", async () => {
    await withTempHome(async (home) => {
      await expectUnauthorizedCommandDropped(home, "/status");
      const runEmbeddedPiAgentMock = mockEmbeddedOk();
      const res = await runInlineUnauthorizedCommand({
        home,
        command: "/status",
      });
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
      expect(prompt).toContain("/status");
    });
  });

  it("enforces elevated toggles across enabled and mention scenarios", async () => {
    await withTempHome(async (home) => {
      const isolateStore = (cfg: ReturnType<typeof makeWhatsAppElevatedCfg>, label: string) => {
        cfg.session = { ...cfg.session, store: join(home, `${label}.sessions.json`) };
        return cfg;
      };

      {
        const cfg = isolateStore(makeWhatsAppElevatedCfg(home, { elevatedEnabled: false }), "off");
        const res = await getReplyFromConfig(
          {
            Body: "/elevated on",
            From: "+1000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toContain("tools.elevated.enabled");

        const storeRaw = await fs.readFile(requireSessionStorePath(cfg), "utf-8");
        const store = JSON.parse(storeRaw) as Record<string, { elevatedLevel?: string }>;
        expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBeUndefined();
      }

      {
        const cfg = isolateStore(
          makeWhatsAppElevatedCfg(home, { requireMentionInGroups: true }),
          "group-on",
        );
        const res = await getReplyFromConfig(
          {
            Body: "/elevated on",
            From: "whatsapp:group:123@g.us",
            To: "whatsapp:+2000",
            Provider: "whatsapp",
            SenderE164: "+1000",
            CommandAuthorized: true,
            ChatType: "group",
            WasMentioned: true,
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toContain("Elevated mode set to ask");
        const store = await readSessionStore(cfg);
        expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe("on");
      }

      {
        const cfg = isolateStore(makeWhatsAppElevatedCfg(home), "inline-unapproved");
        const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
        runEmbeddedPiAgentMock.mockClear();
        runEmbeddedPiAgentMock.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 1,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
          },
        });

        const res = await getReplyFromConfig(
          {
            Body: "please /elevated on now",
            From: "+2000",
            To: "+2000",
            Provider: "whatsapp",
            SenderE164: "+2000",
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).not.toContain("elevated is not available right now");
        expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      }
    });
  });

  it("handles discord elevated allowlist and override behavior", async () => {
    await withTempHome(async (home) => {
      {
        const cfg = makeCfg(home);
        cfg.session = { ...cfg.session, store: join(home, "discord-allow.sessions.json") };
        cfg.tools = { elevated: { allowFrom: { discord: ["123"] } } };

        const res = await getReplyFromConfig(
          {
            Body: "/elevated on",
            From: "discord:123",
            To: "user:123",
            Provider: "discord",
            SenderName: "Peter Steinberger",
            SenderUsername: "steipete",
            SenderTag: "steipete",
            CommandAuthorized: true,
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toContain("Elevated mode set to ask");
        const store = await readSessionStore(cfg);
        expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
      }

      {
        const cfg = makeCfg(home);
        cfg.session = { ...cfg.session, store: join(home, "discord-deny.sessions.json") };
        cfg.tools = {
          elevated: {
            allowFrom: { discord: [] },
          },
        };

        const res = await getReplyFromConfig(
          {
            Body: "/elevated on",
            From: "discord:123",
            To: "user:123",
            Provider: "discord",
            SenderName: "steipete",
          },
          {},
          cfg,
        );
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        expect(text).toContain("tools.elevated.allowFrom.discord");
        expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
      }
    });
  });

  it("returns a context overflow fallback when the embedded agent throws", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockRejectedValue(new Error("Context window exceeded"));

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1002",
          To: "+2000",
        },
        {},
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe(
        "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model.",
      );
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
    });
  });
});
