import { describe, expect, it } from "vitest";
import { deriveSessionMetaPatch } from "./metadata.js";

describe("deriveSessionMetaPatch", () => {
  it("captures origin + group metadata", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "[redacted-email]",
      },
      sessionKey: "agent:main:whatsapp:group:[redacted-email]",
    });

    expect(patch?.origin?.label).toBe("Family id:[redacted-email]");
    expect(patch?.origin?.provider).toBe("whatsapp");
    expect(patch?.subject).toBe("Family");
    expect(patch?.channel).toBe("whatsapp");
    expect(patch?.groupId).toBe("[redacted-email]");
  });
});
