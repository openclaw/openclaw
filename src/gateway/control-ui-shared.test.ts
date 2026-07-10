// Control UI shared tests cover browser-safe assistant avatar URL projection.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { resolveAssistantAvatarUrl } from "./control-ui-shared.js";

describe("resolveAssistantAvatarUrl", () => {
  it("accepts image data URLs only through the shared encoded-size boundary", () => {
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(resolveAssistantAvatarUrl({ avatar: exact, agentId: "main" })).toBe(exact);
    expect(resolveAssistantAvatarUrl({ avatar: `${exact}A`, agentId: "main" })).toBeUndefined();
    expect(
      resolveAssistantAvatarUrl({ avatar: "data:text/plain,avatar", agentId: "main" }),
    ).toBeUndefined();
  });

  it("rejects unsupported URI schemes before local path projection", () => {
    expect(
      resolveAssistantAvatarUrl({ avatar: "slack://avatar.png", agentId: "main" }),
    ).toBeUndefined();
    expect(resolveAssistantAvatarUrl({ avatar: "avatars/openclaw.png", agentId: "main" })).toBe(
      "/avatar/main",
    );
  });
});
