import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionStore,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../../config/sessions.js";
import { resolveSessionDeliveryTarget } from "./targets.js";

describe("resolveSessionDeliveryTarget e2e (Slack stale thread cleanup)", () => {
  it("keeps top-level Slack delivery off-thread after inbound top-level update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-targets-e2e-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:slack:channel:c0afn6nsp8x";
    const staleThreadId = "1772342888.242789";

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "2ce7b2d0-3d90-4106-b33a-6fbb27b65fe9",
            updatedAt: 1,
            chatType: "channel",
            channel: "slack",
            groupId: "c0afn6nsp8x",
            groupChannel: "#claw",
            deliveryContext: {
              channel: "slack",
              to: "channel:C0AFN6NSP8X",
              accountId: "default",
              threadId: staleThreadId,
            },
            lastChannel: "slack",
            lastTo: "channel:C0AFN6NSP8X",
            lastAccountId: "default",
            lastThreadId: staleThreadId,
            origin: {
              provider: "slack",
              surface: "slack",
              chatType: "channel",
              from: "slack:channel:C0AFN6NSP8X",
              to: "channel:C0AFN6NSP8X",
              accountId: "default",
              threadId: staleThreadId,
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    // Simulate a fresh top-level inbound turn in #claw:
    // 1) route update without thread id, 2) inbound metadata update.
    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: {
        channel: "slack",
        to: "channel:C0AFN6NSP8X",
        accountId: "default",
      },
    });
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey,
      ctx: {
        Provider: "slack",
        Surface: "slack",
        ChatType: "channel",
        From: "slack:channel:C0AFN6NSP8X",
        To: "channel:C0AFN6NSP8X",
        SessionKey: sessionKey,
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C0AFN6NSP8X",
        AccountId: "default",
      },
    });

    const entry = loadSessionStore(storePath)[sessionKey];
    expect(entry).toBeDefined();
    expect(entry?.lastThreadId).toBeUndefined();
    expect(entry?.deliveryContext?.threadId).toBeUndefined();
    expect(entry?.origin?.threadId).toBeUndefined();

    const resolved = resolveSessionDeliveryTarget({
      entry,
      requestedChannel: "last",
    });
    expect(resolved.channel).toBe("slack");
    expect(resolved.to).toBe("channel:C0AFN6NSP8X");
    expect(resolved.threadId).toBeUndefined();
  });
});
