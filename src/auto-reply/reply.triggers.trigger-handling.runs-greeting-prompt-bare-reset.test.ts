import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function expectResetBlockedForNonOwner(params: {
  home: string;
  commandAuthorized: boolean;
  getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
}): Promise<void> {
  const { home, commandAuthorized, getReplyFromConfig } = params;
  const cfg = makeCfg(home);
  cfg.channels ??= {};
  cfg.channels.whatsapp = {
    ...cfg.channels.whatsapp,
    allowFrom: ["+1999"],
  };
  cfg.session = {
    ...cfg.session,
    store: join(tmpdir(), `openclaw-session-test-${Date.now()}.json`),
  };
  const res = await getReplyFromConfig(
    {
      Body: "/reset",
      From: "+1003",
      To: "+2000",
      CommandAuthorized: commandAuthorized,
    },
    {},
    cfg,
  );
  expect(res).toBeUndefined();
  expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
}

describe("trigger handling", () => {
  it("runs a greeting prompt for a bare /reset", async () => {
    await withTempHome(async (home) => {
      await runGreetingPromptForBareNewOrReset({ home, body: "/reset", getReplyFromConfig });
    });
  });
  it("runs a greeting prompt for a bare /new", async () => {
    await withTempHome(async (home) => {
      await runGreetingPromptForBareNewOrReset({ home, body: "/new", getReplyFromConfig });
    });
  });
  it("does not reset for unauthorized /reset", async () => {
    await withTempHome(async (home) => {
      await expectResetBlockedForNonOwner({
        home,
        commandAuthorized: false,
        getReplyFromConfig,
      });
    });
  });
  it("blocks /reset for non-owner senders", async () => {
    await withTempHome(async (home) => {
      await expectResetBlockedForNonOwner({
        home,
        commandAuthorized: true,
        getReplyFromConfig,
      });
    });
  });
});
