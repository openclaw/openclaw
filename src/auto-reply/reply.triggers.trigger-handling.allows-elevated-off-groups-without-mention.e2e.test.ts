import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";
import {
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("allows elevated off in groups without mention", async () => {
    await withTempHome(async (home) => {
      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
            groups: { "*": { requireMention: false } },
          },
        },
      };

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

      const store = loadSessionStore(cfg.session.store);
      expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe("off");
    });
  });

  it("allows elevated directive in groups when mentioned", async () => {
    await withTempHome(async (home) => {
      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
            groups: { "*": { requireMention: true } },
          },
        },
      };

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

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<string, { elevatedLevel?: string }>;
      expect(store["agent:main:whatsapp:group:123@g.us"]?.elevatedLevel).toBe("on");
    });
  });

  it("allows elevated directive in direct chats without mentions", async () => {
    await withTempHome(async (home) => {
      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        tools: {
          elevated: {
            allowFrom: { whatsapp: ["+1000"] },
          },
        },
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
      };

      const res = await getReplyFromConfig(
        {
          Body: "/elevated on",
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
      expect(text).toContain("Elevated mode set to ask");

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<string, { elevatedLevel?: string }>;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
    });
  });
});
