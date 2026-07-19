// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveAvatar } from "./identity-avatar.ts";

describe("resolveAvatar", () => {
  it("uses a normalized email id for the Gravatar hash", async () => {
    await expect(resolveAvatar({ id: "  Alice@Example.com  " })).resolves.toEqual({
      kind: "gravatar",
      url: "https://gravatar.com/avatar/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976?d=404&s=64",
    });
  });

  it("falls back to initials for a non-email id", async () => {
    await expect(resolveAvatar({ id: "profile_123" })).resolves.toMatchObject({
      kind: "initials",
      initials: "P",
    });
  });

  it("derives up to two initials from a display name", async () => {
    await expect(resolveAvatar({ name: "Ada Lovelace Byron" })).resolves.toMatchObject({
      kind: "initials",
      initials: "AL",
    });
  });

  it("keeps the initials color deterministic", async () => {
    const first = await resolveAvatar({ id: "profile_123", name: "Ada Lovelace" });
    const second = await resolveAvatar({ id: "profile_123", name: "Renamed User" });
    expect(first.kind).toBe("initials");
    expect(second.kind).toBe("initials");
    if (first.kind === "initials" && second.kind === "initials") {
      expect(first.colorSeed).toBe(second.colorSeed);
    }
  });

  it("lets an already-resolved profile avatar win", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/avatars/alice.png" }),
    ).resolves.toEqual({ kind: "profile", url: "/avatars/alice.png" });
  });
});
