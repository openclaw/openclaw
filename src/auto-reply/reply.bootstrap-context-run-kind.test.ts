import { describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingReplyHarness,
  makeCfg,
  mockRunEmbeddedPiAgentOk,
  withTempHome,
} from "../../test/helpers/auto-reply/trigger-handling-test-harness.js";

type GetReplyFromConfig = typeof import("./reply.js").getReplyFromConfig;

let getReplyFromConfig!: GetReplyFromConfig;
installTriggerHandlingReplyHarness((impl) => {
  getReplyFromConfig = impl;
});

describe("getReplyFromConfig bootstrap context run kind", () => {
  it("passes explicit heartbeat runner bootstrap kind to the embedded agent", async () => {
    await withTempHome(async (home) => {
      mockRunEmbeddedPiAgentOk();

      await getReplyFromConfig(
        {
          Body: "check scheduled work",
          From: "+1000",
          To: "+2000",
          ChatType: "direct",
          Provider: "whatsapp",
          Surface: "whatsapp",
          SenderE164: "+1000",
          SessionKey: "agent:main:whatsapp:+1000",
        },
        {
          isHeartbeat: true,
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        },
        makeCfg(home),
      );

      const embeddedCall = getRunEmbeddedPiAgentMock().mock.calls.at(-1)?.[0];
      expect(embeddedCall).toMatchObject({
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "cron",
        trigger: "heartbeat",
      });
    });
  });
});
