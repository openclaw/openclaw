import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  MAIN_SESSION_KEY,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("keeps inline /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
      };

      const res = await getReplyFromConfig(
        {
          Body: "please /status now",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      // Not allowlisted: inline /status is treated as plain text and is not stripped.
      expect(prompt).toContain("/status");
    });
  });

  it("keeps inline /help for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
      };

      const res = await getReplyFromConfig(
        {
          Body: "please /help now",
          From: "+2001",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+2001",
        },
        {},
        cfg,
      );
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
      const baseCfg = makeCfg(home);
      const cfg = {
        ...baseCfg,
        channels: {
          ...baseCfg.channels,
          whatsapp: {
            allowFrom: ["+1000"],
          },
        },
      };

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

      const storeRaw = await fs.readFile(cfg.session.store, "utf-8");
      const store = JSON.parse(storeRaw) as Record<string, { sendPolicy?: string }>;
      expect(store[MAIN_SESSION_KEY]?.sendPolicy).toBe("deny");
    });
  });
});
