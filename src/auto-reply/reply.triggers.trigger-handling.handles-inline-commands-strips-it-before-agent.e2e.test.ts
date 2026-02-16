import { beforeAll, describe, expect, it } from "vitest";
import {
  createBlockReplyCollector,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("handles inline /commands and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockRunEmbeddedPiAgentOk();
      const { blockReplies, handlers } = createBlockReplyCollector();
      const res = await getReplyFromConfig(
        {
          Body: "please /commands now",
          From: "+1002",
          To: "+2000",
          CommandAuthorized: true,
        },
        handlers,
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Slash commands");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/commands");
      expect(text).toBe("ok");
    });
  });

  it("handles inline /whoami and strips it before the agent", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = mockRunEmbeddedPiAgentOk();
      const { blockReplies, handlers } = createBlockReplyCollector();
      const res = await getReplyFromConfig(
        {
          Body: "please /whoami now",
          From: "+1002",
          To: "+2000",
          SenderId: "12345",
          CommandAuthorized: true,
        },
        handlers,
        makeCfg(home),
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(blockReplies.length).toBe(1);
      expect(blockReplies[0]?.text).toContain("Identity");
      expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
      const prompt = runEmbeddedPiAgentMock.mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).not.toContain("/whoami");
      expect(text).toBe("ok");
    });
  });

  it("drops /status for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
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
          Body: "/status",
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
    });
  });

  it("drops /whoami for unauthorized senders", async () => {
    await withTempHome(async (home) => {
      const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
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
          Body: "/whoami",
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
    });
  });
});
