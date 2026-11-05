// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { userProfileAvatarUrl } from "./profile-avatar-url.ts";

afterEach(() => vi.unstubAllGlobals());

describe("userProfileAvatarUrl", () => {
  it("builds scoped cache-busted avatar URLs", () => {
    vi.stubGlobal("location", { href: "https://gateway.example.test/control/profile" });
    expect(
      userProfileAvatarUrl("wss://gateway.example.test/control", "profile/1", 42, "/control"),
    ).toBe("https://gateway.example.test/control/api/users/profile%2F1/avatar?v=42");
    expect(userProfileAvatarUrl("wss://remote.example.test", "profile-1", "content-hash-png")).toBe(
      "https://remote.example.test/api/users/profile-1/avatar?v=content-hash-png",
    );
  });
});
