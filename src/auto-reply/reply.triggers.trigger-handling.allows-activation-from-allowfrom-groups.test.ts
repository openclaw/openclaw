import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  runGreetingPromptForBareNewOrReset,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("allows /activation from allowFrom in groups", async () => {
    await withTempHome(async (home) => {
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
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
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
  it("runs a greeting prompt for a bare /new", async () => {
    await withTempHome(async (home) => {
      await runGreetingPromptForBareNewOrReset({ home, body: "/new", getReplyFromConfig });
    });
  });
});
