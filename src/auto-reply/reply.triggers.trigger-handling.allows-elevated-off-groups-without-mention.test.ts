import { beforeAll, describe, expect, it } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import {
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
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

      const store = loadSessionStore(requireSessionStorePath(cfg));
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
});
