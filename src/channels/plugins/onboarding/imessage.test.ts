import { describe, expect, it } from "vitest";
import { parseIMessageAllowFromEntries } from "./imessage.js";

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles and chat targets", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, chat_id:123, chat_guid:abc")).toEqual({
      entries: ["+15555550123", "chat_id:123", "chat_guid:abc"],
    });
  });

  it("returns validation errors for invalid chat_id", () => {
    expect(parseIMessageAllowFromEntries("chat_id:abc")).toEqual({
      entries: [],
      error: "Invalid chat_id: chat_id:abc",
    });
  });

  it("returns validation errors for invalid chat_identifier entries", () => {
    expect(parseIMessageAllowFromEntries("chat_identifier:")).toEqual({
      entries: [],
      error: "Invalid chat_identifier entry",
    });
  });
});
