import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearSignalReactionTargetCacheForTests,
  recordSignalReactionTarget,
  resolveSignalReactionTarget,
} from "./reaction-target-cache.js";

describe("signal reaction target cache", () => {
  beforeEach(() => {
    __clearSignalReactionTargetCacheForTests();
  });

  it("records and resolves uuid authors", () => {
    recordSignalReactionTarget({
      groupId: "group-id",
      messageId: "1771181675531",
      senderId: "uuid:e489bcc7-6a67-429f-8278-a5710dcd8b02",
    });

    expect(
      resolveSignalReactionTarget({
        groupId: "group-id",
        messageId: "1771181675531",
      }),
    ).toEqual({
      targetAuthorUuid: "e489bcc7-6a67-429f-8278-a5710dcd8b02",
      targetAuthor: undefined,
    });
  });

  it("records and resolves phone authors when uuid is unavailable", () => {
    recordSignalReactionTarget({
      groupId: "group-id",
      messageId: "1771181675531",
      senderE164: "+15551230000",
    });

    expect(
      resolveSignalReactionTarget({
        groupId: "group-id",
        messageId: "1771181675531",
      }),
    ).toEqual({
      targetAuthorUuid: undefined,
      targetAuthor: "+15551230000",
    });
  });

  it("normalizes signal/group prefixes", () => {
    recordSignalReactionTarget({
      groupId: "signal:group:imrDE/AziMTrojCb1ngE9WcREGjKxjRq30krncLOZnM=",
      messageId: "1771181675531",
      senderId: "e489bcc7-6a67-429f-8278-a5710dcd8b02",
    });

    expect(
      resolveSignalReactionTarget({
        groupId: "group:imrDE/AziMTrojCb1ngE9WcREGjKxjRq30krncLOZnM=",
        messageId: "1771181675531",
      }),
    ).toEqual({
      targetAuthorUuid: "e489bcc7-6a67-429f-8278-a5710dcd8b02",
      targetAuthor: undefined,
    });
  });
});
