import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  expectDirectElevatedToggleOn,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  MAIN_SESSION_KEY,
  makeCfg,
  makeWhatsAppElevatedCfg,
  readSessionStore,
  requireSessionStorePath,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  getReplyFromConfig = await loadGetReplyFromConfig();
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("allows approved sender to toggle elevated mode", async () => {
    await expectDirectElevatedToggleOn({ getReplyFromConfig });
  });
  it("rejects elevated toggles when disabled", async () => {
    await withTempHome(async (home) => {
      const cfg = makeWhatsAppElevatedCfg(home, { elevatedEnabled: false });

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
    });
  });

  it("allows elevated off in groups without mention", async () => {
    await withTempHome(async (home) => {
      const cfg = makeWhatsAppElevatedCfg(home, { requireMentionInGroups: false });

      const res = await getReplyFromConfig(
        {
          Body: "/elevated off",
          From: "whatsapp:group:123@g.us",
          To: "whatsapp:+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          CommandAuthorized: true,
          ChatType: "group",
          WasMentioned: false,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toContain("Elevated mode disabled.");

      const store = await readSessionStore(cfg);
      expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe("off");
    });
  });

  it("allows elevated directive in groups when mentioned", async () => {
    await withTempHome(async (home) => {
      const cfg = makeWhatsAppElevatedCfg(home, { requireMentionInGroups: true });

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
    });
  });

  it("ignores elevated directive in groups when not mentioned", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const cfg = makeWhatsAppElevatedCfg(home, { requireMentionInGroups: false });

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "whatsapp:group:123@g.us",
          To: "whatsapp:+2000",
          Provider: "whatsapp",
          SenderE164: "+1000",
          ChatType: "group",
          WasMentioned: false,
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBeUndefined();
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });

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
