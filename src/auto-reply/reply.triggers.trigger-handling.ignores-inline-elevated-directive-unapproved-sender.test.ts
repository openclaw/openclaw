import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  MAIN_SESSION_KEY,
  makeCfg,
  makeWhatsAppElevatedCfg,
  readSessionStore,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  getReplyFromConfig = await loadGetReplyFromConfig();
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("ignores inline elevated directive for unapproved sender", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = makeWhatsAppElevatedCfg(home);

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
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalled();
    });
  });
  it("uses tools.elevated.allowFrom.discord for elevated approval", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
      cfg.tools = { elevated: { allowFrom: { discord: ["steipete"] } } };

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
    });
  });
  it("treats explicit discord elevated allowlist as override", async () => {
    await withTempHome(async (home) => {
      const cfg = makeCfg(home);
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
