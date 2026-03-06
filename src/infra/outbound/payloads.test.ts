import { describe, expect, it } from "vitest";

import { normalizeReplyPayloadsForDelivery } from "./payloads.js";

describe("normalizeReplyPayloadsForDelivery", () => {
  it("suppresses NO_REPLY even when delivered as a JSON action payload", () => {
    const normalized = normalizeReplyPayloadsForDelivery([
      { text: "{\"action\":\"NO_REPLY\"}" },
      { text: "{\n  \"action\": \"NO_REPLY\"\n}" },
    ]);
    expect(normalized).toEqual([]);
  });

  it("does not suppress arbitrary JSON that is not a NO_REPLY action", () => {
    const normalized = normalizeReplyPayloadsForDelivery([
      { text: "{\"action\":\"SOMETHING_ELSE\"}" },
    ]);
    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "{\"action\":\"SOMETHING_ELSE\"}" }),
      ]),
    );
  });
});
