// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { resolveAvatar, setAvatarGatewayOrigin } from "./identity-avatar.ts";

afterEach(() => {
  setAvatarGatewayOrigin(null);
});

describe("resolveAvatar", () => {
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
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).resolves.toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });
});

describe("resolveAvatar profile URL origin restriction", () => {
  it("rejects absolute profile URLs from sender metadata", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "https://evil.example/a.png" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  it("rejects protocol-relative profile URLs", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "//evil.example/a.png" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  it("rejects backslash and control-character parser bypasses", async () => {
    for (const url of [
      "/\\evil.example/a.png",
      "\\/evil.example/a.png",
      "/\t/evil.example/a.png",
      "htt\nps://evil.example/a.png",
    ]) {
      await expect(
        resolveAvatar({ id: "alice@example.com", profileAvatarUrl: url }),
      ).resolves.toMatchObject({ kind: "initials" });
    }
  });

  it("accepts the canonical same-origin avatar route", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).resolves.toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });

  it("rejects a same-origin path that is not the avatar route", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/secrets" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  it("drops sender-controlled query and fragment on the avatar route", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar?v=2#f" }),
    ).resolves.toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });
});

describe("resolveAvatar gateway origin trust", () => {
  it("keeps relative avatar paths relative when no gateway origin is set", async () => {
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).resolves.toEqual({ kind: "profile", url: "/api/users/p1/avatar" });
  });

  it("resolves relative paths against the configured gateway origin", async () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    await expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).resolves.toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("allows an absolute URL only when it matches the gateway origin", async () => {
    setAvatarGatewayOrigin("https://gw.example.com");
    await expect(
      resolveAvatar({
        id: "a@example.com",
        profileAvatarUrl: "https://gw.example.com/api/users/p1/avatar",
      }),
    ).resolves.toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("rejects an absolute URL from a different origin than the gateway", async () => {
    setAvatarGatewayOrigin("https://gw.example.com");
    await expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "https://evil.example/a.png" }),
    ).resolves.toMatchObject({ kind: "initials" });
  });

  // NOTE: the trusted origin can only come from setAvatarGatewayOrigin — the
  // IdentityAvatarInput type has no gatewayOrigin field, so sender metadata
  // cannot influence it (compile-time enforced; no runtime test needed).

  it("honors the app-wide gateway origin set via setAvatarGatewayOrigin", async () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    await expect(
      resolveAvatar({ id: "a@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).resolves.toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });
});
