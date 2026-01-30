import { describe, expect, it } from "vitest";

import { deriveSessionMetaPatch } from "./metadata.js";

describe("deriveSessionMetaPatch", () => {
  it("captures origin + group metadata", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(patch?.origin?.label).toBe("Family id:123@g.us");
    expect(patch?.origin?.provider).toBe("whatsapp");
    expect(patch?.subject).toBe("Family");
    expect(patch?.channel).toBe("whatsapp");
    expect(patch?.groupId).toBe("123@g.us");
  });

  it("skips displayName when skipDisplayName is true", () => {
    const patchWithDisplayName = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(patchWithDisplayName?.displayName).toBeDefined();

    const patchWithoutDisplayName = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      skipDisplayName: true,
    });
    expect(patchWithoutDisplayName?.displayName).toBeUndefined();
    // Other fields should still be present
    expect(patchWithoutDisplayName?.subject).toBe("Family");
    expect(patchWithoutDisplayName?.channel).toBe("whatsapp");
    expect(patchWithoutDisplayName?.groupId).toBe("123@g.us");
  });
});
