import { beforeAll, describe, expect, it } from "vitest";
import {
  expectInlineCommandHandledAndStripped,
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  loadGetReplyFromConfig,
  makeCfg,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  getReplyFromConfig = await loadGetReplyFromConfig();
});

installTriggerHandlingE2eTestHooks();

async function expectUnauthorizedCommandDropped(home: string, body: "/status" | "/whoami") {
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
});
