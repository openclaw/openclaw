import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeWhatsAppElevatedCfg,
  runDirectElevatedToggleAndLoadStore,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("allows approved sender to toggle elevated mode", async () => {
    await withTempHome(async (home) => {
      const cfg = makeWhatsAppElevatedCfg(home);
      const { text, store } = await runDirectElevatedToggleAndLoadStore({
        cfg,
        getReplyFromConfig,
      });
      expect(text).toContain("Elevated mode set to ask");
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBe("on");
    });
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

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<string, { elevatedLevel?: string }>;
      expect(store[MAIN_SESSION_KEY]?.elevatedLevel).toBeUndefined();
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
});
