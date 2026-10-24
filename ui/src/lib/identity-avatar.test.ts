// @vitest-environment node
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "./identity-avatar-context.ts";
import {
  captureIdentityAvatarSnapshot,
  resolveAvatarImageUrl,
  restoreIdentityAvatarSnapshot,
  retainAvatarImageUrl,
} from "./identity-avatar-loader.ts";
import { resolveAvatar, resolveIdentityHue } from "./identity-avatar.ts";

function avatarResponse(mime = "image/png") {
  return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": mime } });
}

afterEach(() => {
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveAvatar", () => {
  it("falls back to initials for a non-email id", () => {
    expect(resolveAvatar({ id: "profile_123" })).toMatchObject({
      kind: "initials",
      initials: "P",
    });
  });

  it("derives up to two initials from a display name", () => {
    expect(resolveAvatar({ name: "Ada Lovelace Byron" })).toMatchObject({
      kind: "initials",
      initials: "AL",
    });
  });

  it("derives a stable identity hue from the same seed as the initials color", () => {
    const first = resolveIdentityHue({ id: "profile_123", name: "Ada Lovelace" });
    const second = resolveIdentityHue({ id: "profile_123", name: "Renamed User" });
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(360);
    const resolved = resolveAvatar({ id: "profile_123" });
    if (resolved.kind === "initials") {
      expect(first).toBe(resolved.colorSeed % 360);
    }
  });
});

describe("resolveAvatar profile URL origin restriction", () => {
  it("rejects backslash and control-character parser bypasses", () => {
    for (const url of [
      "/\\evil.example/a.png",
      "\\/evil.example/a.png",
      "/\t/evil.example/a.png",
      "htt\nps://evil.example/a.png",
    ]) {
      expect(resolveAvatar({ id: "alice@example.com", profileAvatarUrl: url })).toMatchObject({
        kind: "initials",
      });
    }
  });

  it("preserves the version query but drops the fragment on the avatar route", () => {
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar?v=2#f" }),
    ).toEqual({ kind: "profile", url: "/api/users/p1/avatar?v=2" });
  });
});

describe("resolveAvatar gateway origin trust", () => {
  it.each(["", "/openclaw"])(
    "preserves development avatar mounts and origin trust at %s",
    (basePath) => {
      const gatewayUrl = `wss://gateway.example${basePath}`;
      const proxyPath = `/__openclaw_dev_gateway__/${encodeURIComponent(gatewayUrl)}`;
      const resourceBasePath = `${proxyPath}${basePath}`;
      const uiOrigin = "http://localhost:5173";
      vi.stubGlobal("location", new URL(uiOrigin));
      vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", { gatewayUrl, proxyPath });
      setAvatarGatewayOrigin(gatewayUrl, [], resourceBasePath);

      for (const profileAvatarUrl of new Set([
        "/api/users/p1/avatar?v=2#fragment",
        `${basePath}/api/users/p1/avatar?v=2#fragment`,
        `${resourceBasePath}/api/users/p1/avatar?v=2#fragment`,
        "https://gateway.example/api/users/p1/avatar?v=2#fragment",
        `https://gateway.example${basePath}/api/users/p1/avatar?v=2#fragment`,
        `${uiOrigin}${resourceBasePath}/api/users/p1/avatar?v=2#fragment`,
      ])) {
        expect(resolveAvatar({ id: "p1", profileAvatarUrl }), profileAvatarUrl).toEqual({
          kind: "profile",
          url: `${uiOrigin}${resourceBasePath}/api/users/p1/avatar?v=2`,
        });
      }
      expect(resolveAvatar({ id: "p1", identity: { type: "profile", id: "p1" } })).toMatchObject({
        kind: "initials",
      });
      for (const profileAvatarUrl of [
        `${basePath}/avatar/research?v=3`,
        `${resourceBasePath}/avatar/research?v=3`,
        `https://gateway.example${basePath}/avatar/research?v=3`,
      ]) {
        expect(
          resolveAvatar({
            id: "research",
            identity: { type: "agent", id: "research" },
            profileAvatarUrl,
          }),
        ).toEqual({ kind: "profile", url: `${uiOrigin}${resourceBasePath}/avatar/research?v=3` });
      }
      for (const profileAvatarUrl of [
        "https://other.example/api/users/p1/avatar",
        `https://other.example${basePath}/api/users/p1/avatar`,
        `https://other.example${resourceBasePath}/api/users/p1/avatar`,
        `${basePath}/api/users/p1/avatar/extra`,
      ]) {
        expect(resolveAvatar({ id: "p1", profileAvatarUrl }), profileAvatarUrl).toMatchObject({
          kind: "initials",
        });
      }
      if (basePath) {
        expect(
          resolveAvatar({ id: "research", profileAvatarUrl: "/avatar/research" }),
        ).toMatchObject({
          kind: "initials",
        });
      }
    },
  );

  it.each([
    ["https://gw.example.com", "", "/avatar/research", "/avatar/research"],
    [
      "https://gw.example.com",
      "/control",
      "/control/avatar/research?v=2#f",
      "/control/avatar/research?v=2",
    ],
    ["https://ui.example.com", "/control", "/avatar/research", "/avatar/research"],
  ])(
    "resolves agent images for page %s and mount %s",
    (pageOrigin, basePath, avatarUrl, expectedPath) => {
      vi.stubGlobal("location", { origin: pageOrigin });
      setAvatarGatewayOrigin("wss://gw.example.com/ws", [], basePath);
      for (const identity of [undefined, { type: "agent" as const, id: "research" }]) {
        expect(resolveAvatar({ id: "research", identity, profileAvatarUrl: avatarUrl })).toEqual({
          kind: "profile",
          url: `https://gw.example.com${expectedPath}`,
        });
      }
    },
  );

  it("applies an explicit base path for a same-origin gateway", () => {
    vi.stubGlobal("location", { origin: "https://gw.example.com" });
    setAvatarGatewayOrigin("wss://gw.example.com/ws", [], "/wilfred");
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar?v=2" }),
    ).toEqual({
      kind: "profile",
      url: "https://gw.example.com/wilfred/api/users/p1/avatar?v=2",
    });
  });

  it("never infers a base path from the WebSocket pathname", () => {
    vi.stubGlobal("location", { origin: "https://gw.example.com" });
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("does not apply the page base path to a cross-origin gateway", () => {
    vi.stubGlobal("location", { origin: "https://ui.example.com" });
    setAvatarGatewayOrigin("wss://gw.example.com/ws", [], "/wilfred");
    expect(
      resolveAvatar({ id: "alice@example.com", profileAvatarUrl: "/api/users/p1/avatar" }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });

  it("rejects non-exact avatar routes under a same-origin mount", () => {
    vi.stubGlobal("location", { origin: "https://gw.example.com" });
    setAvatarGatewayOrigin("wss://gw.example.com/ws", [], "/wilfred");
    for (const profileAvatarUrl of [
      "https://gw.example.com/wilfred/api/users/p1/avatar/extra",
      "https://gw.example.com/wilfred/api/users/p1/avatar/other",
      "https://gw.example.com/wilfred/api/secrets",
    ]) {
      expect(resolveAvatar({ id: "alice@example.com", profileAvatarUrl })).toMatchObject({
        kind: "initials",
      });
    }
  });

  it("allows an absolute URL only when it matches the gateway origin", () => {
    setAvatarGatewayOrigin("https://gw.example.com");
    expect(
      resolveAvatar({
        id: "a@example.com",
        profileAvatarUrl: "https://gw.example.com/api/users/p1/avatar",
      }),
    ).toEqual({ kind: "profile", url: "https://gw.example.com/api/users/p1/avatar" });
  });
});

describe("resolveAvatar profile-id senders", () => {
  it("sender provenance keeps an unqualified UUID on initials", () => {
    expect(resolveAvatar({ id: " c3e32452-0467-47e5-aafa-233cd5dae29f " })).toMatchObject({
      kind: "initials",
    });
  });

  it.each([undefined, "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar"])(
    "does not upgrade a typed remote participant from its id or display metadata: %s",
    (profileAvatarUrl) => {
      expect(
        resolveAvatar({
          id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
          name: "steipete",
          profileAvatarUrl,
          identity: {
            type: "observation",
            id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
            pluginId: "test",
            accountId: null,
            senderKind: "unknown",
          },
        }),
      ).toMatchObject({ kind: "initials" });
    },
  );

  it("keeps profiles without an advertised avatar on initials", () => {
    setAvatarGatewayOrigin("wss://gw.example.com/ws");
    expect(
      resolveAvatar({
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        identity: { type: "profile", id: "c3e32452-0467-47e5-aafa-233cd5dae29f" },
      }),
    ).toMatchObject({ kind: "initials" });
  });

  it.each([undefined, "/api/users/c3e32452-0467-47e5-aafa-233cd5dae29f/avatar"])(
    "does not turn a typed agent into a profile from a UUID or user image: %s",
    (profileAvatarUrl) => {
      const id = "c3e32452-0467-47e5-aafa-233cd5dae29f";
      expect(
        resolveAvatar({ id, identity: { type: "agent", id }, profileAvatarUrl }),
      ).toMatchObject({
        kind: "initials",
      });
    },
  );

  it("keeps a typed profile in the user image namespace", () => {
    expect(
      resolveAvatar({
        id: "person",
        identity: { type: "profile", id: "person" },
        profileAvatarUrl: "/avatar/research",
      }),
    ).toMatchObject({ kind: "initials" });
  });

  it("uses an explicit trusted revisioned route", () => {
    expect(
      resolveAvatar({
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
        profileAvatarUrl: "/api/users/other-profile/avatar?v=9",
      }),
    ).toEqual({ kind: "profile", url: "/api/users/other-profile/avatar?v=9" });
  });
});

describe("authenticated profile avatar cache", () => {
  it.each(["/api/users/profile-ada/avatar?v=7", "/avatar/research?v=7"])(
    "restores the admitted revision of %s synchronously without a request",
    async (path) => {
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => avatarResponse());
      vi.spyOn(URL, "createObjectURL")
        .mockReturnValueOnce("blob:previous-document")
        .mockReturnValueOnce("blob:restored-document")
        .mockReturnValueOnce("blob:new-revision")
        .mockReturnValueOnce("blob:refetched-revision");
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      await resolveAvatarImageUrl(path);
      const images = await captureIdentityAvatarSnapshot([path, path, "/avatar/not-displayed?v=1"]);
      expect(images).toEqual([
        { url: `https://gateway.example.test${path}`, dataUrl: "data:image/png;base64,AQID" },
      ]);
      setAvatarGatewayOrigin(null);
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      const retire = restoreIdentityAvatarSnapshot(images);
      await retire.ready;
      expect(resolveAvatarImageUrl(path)).toBe("blob:restored-document");
      expect(fetchAvatar).toHaveBeenCalledOnce();
      await expect(resolveAvatarImageUrl(path.replace("v=7", "v=8"))).resolves.toBe(
        "blob:new-revision",
      );
      retire.release();
      expect(revoke).toHaveBeenCalledWith("blob:restored-document");
      expect(resolveAvatarImageUrl(path.replace("v=7", "v=8"))).toBe("blob:new-revision");
      await expect(resolveAvatarImageUrl(path)).resolves.toBe("blob:refetched-revision");
    },
  );

  it("excludes unknown revisions, another Gateway, and images that exceed the snapshot budget", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array(64 * 1024), { headers: { "content-type": "image/png" } }),
    );
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:snapshot-${sequence++}`);
    const paths = ["/avatar/unversioned", "/avatar/one?v=1", "/avatar/two?v=1"];
    await Promise.all(paths.map((path) => resolveAvatarImageUrl(path)));
    const images = await captureIdentityAvatarSnapshot([
      ...paths,
      "https://other.example.test/avatar/one?v=1",
    ]);
    expect(images.map((image) => image.url)).toEqual([
      "https://gateway.example.test/avatar/one?v=1",
    ]);
    expect(JSON.stringify(images).length).toBeLessThan(128 * 1024);
    setAvatarGatewayOrigin("https://replacement.example.test", ["replacement-token"]);
    restoreIdentityAvatarSnapshot(images);
    expect(sequence).toBe(3);
  });

  it("retires snapshot bytes if credentials change while encoding", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["first-token"]);
    const bytes = createDeferred<ArrayBuffer>();
    const response = avatarResponse();
    const blob = await response.clone().blob();
    vi.spyOn(blob, "arrayBuffer").mockReturnValue(bytes.promise);
    vi.spyOn(response, "blob").mockResolvedValue(blob);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first-profile");
    await resolveAvatarImageUrl("/api/users/ada/avatar?v=1");
    const capture = captureIdentityAvatarSnapshot(["/api/users/ada/avatar?v=1"]);
    setAvatarGatewayOrigin("https://gateway.example.test", ["replacement-token"]);
    bytes.resolve(new Uint8Array([1, 2, 3]).buffer);
    await expect(capture).resolves.toEqual([]);
  });

  it("waits only for requested in-flight images without starting resource reads", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const requested = createDeferred<Response>();
    const unrelated = createDeferred<Response>();
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(requested.promise)
      .mockReturnValueOnce(unrelated.promise);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:requested-image");
    const pending = resolveAvatarImageUrl("/avatar/requested?v=1");
    const ignored = resolveAvatarImageUrl("/avatar/unrelated?v=1");
    const capture = captureIdentityAvatarSnapshot(["/avatar/requested?v=1", "/avatar/unknown?v=1"]);
    requested.resolve(avatarResponse());
    try {
      await expect(capture).resolves.toEqual([
        {
          url: "https://gateway.example.test/avatar/requested?v=1",
          dataUrl: "data:image/png;base64,AQID",
        },
      ]);
    } finally {
      unrelated.resolve(new Response(null, { status: 404 }));
      await Promise.all([pending, ignored]);
    }
    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it("rejects snapshot payloads outside the authenticated loader's image MIME contract", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    restoreIdentityAvatarSnapshot([
      { url: "/avatar/invalid?v=1", dataUrl: "data:text/html;base64,AQID" },
      { url: "/api/users/ada/avatar?v=1", dataUrl: "data:image/png;base64,invalid!" },
    ]);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("prepares cached blob decoding without an authenticated resource read", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const decoding = createDeferred<void>();
    const images: Array<{ src: string }> = [];
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        constructor() {
          images.push(this);
        }
        decode() {
          return decoding.promise;
        }
      },
    );
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-decode");
    const restored = restoreIdentityAvatarSnapshot([
      { url: "/avatar/cedar?v=1", dataUrl: "data:image/png;base64,AQID" },
    ]);
    expect(images.map((image) => image.src)).toEqual(["blob:cached-decode"]);
    const ready = vi.fn();
    void restored.ready.then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    decoding.resolve();
    await restored.ready;
    expect(resolveAvatarImageUrl("/avatar/cedar?v=1")).toBe("blob:cached-decode");
    expect(fetchAvatar).not.toHaveBeenCalled();
    restored.release();
    restored.release();
  });

  it("falls back on a failed cached decode without refetching or reviving retired images", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const firstDecode = createDeferred<void>();
    let decodes = 0;
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode() {
          return decodes++ === 0 ? Promise.reject(new Error("invalid image")) : firstDecode.promise;
        }
      },
    );
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => avatarResponse());
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:invalid-cache")
      .mockReturnValueOnce("blob:retired-cache")
      .mockReturnValueOnce("blob:current-image");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const failed = restoreIdentityAvatarSnapshot([
      { url: "/avatar/cedar?v=1", dataUrl: "data:image/png;base64,AQID" },
    ]);
    await failed.ready;
    expect(resolveAvatarImageUrl("/avatar/cedar?v=1")).toBeNull();
    expect(fetchAvatar).not.toHaveBeenCalled();
    failed.release();
    const retired = restoreIdentityAvatarSnapshot([
      { url: "/avatar/cedar?v=1", dataUrl: "data:image/png;base64,AQID" },
    ]);
    setAvatarGatewayOrigin("https://gateway.example.test", ["replacement-token"]);
    await expect(resolveAvatarImageUrl("/avatar/cedar?v=1")).resolves.toBe("blob:current-image");
    firstDecode.reject(new Error("retired image"));
    await retired.ready;
    retired.release();
    expect(resolveAvatarImageUrl("/avatar/cedar?v=1")).toBe("blob:current-image");
    expect(revoke).toHaveBeenCalledWith("blob:invalid-cache");
    expect(revoke).toHaveBeenCalledWith("blob:retired-cache");
    expect(revoke).not.toHaveBeenCalledWith("blob:current-image");
    expect(fetchAvatar).toHaveBeenCalledOnce();
  });

  it.each([404, 503])(
    "restores revisioned %s misses until their original retry deadline",
    async (status) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(0);
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockImplementation(async () => avatarResponse());
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new-upload");
      vi.stubGlobal(
        "Image",
        class {
          constructor() {
            throw new Error("A cached miss must never create a decoder");
          }
          decode() {
            return Promise.resolve();
          }
        },
      );
      const path = "/api/users/ada/avatar?v=1";
      await expect(resolveAvatarImageUrl(path)).resolves.toBeNull();
      const images = await captureIdentityAvatarSnapshot([path]);
      expect(images).toEqual([
        { url: `https://gateway.example.test${path}`, dataUrl: null, retryAt: 60_000 },
      ]);
      setAvatarGatewayOrigin(null);
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      clock.mockReturnValue(50_000);
      const restored = restoreIdentityAvatarSnapshot(images);
      await restored.ready;
      expect(resolveAvatarImageUrl(path)).toBeNull();
      expect(await captureIdentityAvatarSnapshot([path])).toEqual(images);
      expect(fetchAvatar).toHaveBeenCalledOnce();
      clock.mockReturnValue(60_000);
      expect(await captureIdentityAvatarSnapshot([path])).toEqual([]);
      await expect(resolveAvatarImageUrl(path)).resolves.toBe("blob:new-upload");
      restored.release();
      expect(resolveAvatarImageUrl(path)).toBe("blob:new-upload");
      setAvatarGatewayOrigin(null);
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      const expired = restoreIdentityAvatarSnapshot(images);
      await expired.ready;
      await expect(resolveAvatarImageUrl(path)).resolves.toBe("blob:new-upload");
      expect(fetchAvatar).toHaveBeenCalledTimes(3);
      expired.release();
    },
  );

  it.each([
    ["/api/users/profile-ada/avatar?v=7", "image/png"],
    ["/avatar/research", "image/svg+xml"],
    ["/avatar/research?v=7", "image/avif"],
  ])("shares one authenticated fetch for %s (%s)", async (avatarPath, mimeType) => {
    setAvatarGatewayOrigin("wss://gateway.example.test/ws", ["profile-token"]);
    const response = avatarResponse(mimeType);
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-ada");

    const first = resolveAvatarImageUrl(avatarPath);
    const second = resolveAvatarImageUrl(avatarPath);

    await expect(first).resolves.toBe("blob:profile-ada");
    await expect(second).resolves.toBe("blob:profile-ada");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      `https://gateway.example.test${avatarPath}`,
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer profile-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("yields cold image admission and skips a retired credential context", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["old-token"]);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => avatarResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:current-profile");
    const path = "/api/users/profile-ada/avatar?v=7";
    const retired = resolveAvatarImageUrl(path);
    expect(resolveAvatarImageUrl(path)).toBe(retired);
    expect(fetchAvatar).not.toHaveBeenCalled();

    setAvatarGatewayOrigin("https://gateway.example.test", ["current-token"]);
    const current = resolveAvatarImageUrl(path);
    await expect(retired).resolves.toBeNull();
    await expect(current).resolves.toBe("blob:current-profile");
    expect(fetchAvatar).toHaveBeenCalledExactlyOnceWith(
      `https://gateway.example.test${path}`,
      expect.objectContaining({ headers: { Authorization: "Bearer current-token" } }),
    );
  });

  it("refetches when the gateway publishes a newer avatar revision", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => avatarResponse());
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:profile-v7")
      .mockReturnValueOnce("blob:profile-v8");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
      "blob:profile-v7",
    );
    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=8")).resolves.toBe(
      "blob:profile-v8",
    );

    expect(fetchAvatar).toHaveBeenCalledTimes(2);
  });

  it.each([404, 503])(
    "coalesces an avatar returning %s before retrying an unversioned upload after one minute",
    async (status) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(0);
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token", "profile-password"]);
      const cancel = vi.fn();
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
        .mockResolvedValueOnce(avatarResponse());
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:profile-uploaded");

      const missing = resolveAvatarImageUrl("/api/users/profile-ada/avatar");
      expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar")).toBe(missing);
      await expect(missing).resolves.toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      clock.mockReturnValue(59_999);
      expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar")).toBeNull();
      expect(
        resolveAvatarImageUrl("/api/users/profile-ada/avatar", "/api/users/profile-ada/avatar"),
      ).toBeNull();
      expect(fetchAvatar).toHaveBeenCalledOnce();

      clock.mockReturnValue(60_000);
      await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar")).resolves.toBe(
        "blob:profile-uploaded",
      );

      expect(fetchAvatar).toHaveBeenCalledTimes(2);
    },
  );

  it("releases a streaming miss while its fallback remains cached", async () => {
    let socketClosed = false;
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.socket.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.write('{"ok":false,"error":{"type":"not_found"}}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback listener");
      }
      setAvatarGatewayOrigin(`http://127.0.0.1:${address.port}`, ["profile-token"]);

      await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBeNull();
      await vi.waitFor(() => expect(socketClosed).toBe(true), { timeout: 1_000 });
      expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).toBeNull();
      expect(requestCount).toBe(1);
    } finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });

  it.for(["fulfilled", "rejected"])(
    "does not delay a cached miss for stalled body cleanup that is later %s",
    async (outcome, { signal }) => {
      setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
      const cancellation = createDeferred();
      const response = new Response(new ReadableStream({ cancel: () => cancellation.promise }), {
        status: 404,
      });
      const cancel = vi.spyOn(response.body!, "cancel");
      const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const missing = resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7");
      try {
        await expect(withinTest(Promise.resolve(missing), signal)).resolves.toBeNull();
        expect(cancel).toHaveBeenCalledOnce();
        expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).toBeNull();
        expect(fetchAvatar).toHaveBeenCalledOnce();

        if (outcome === "rejected") {
          cancellation.reject(new Error("cleanup failed"));
          await cancellation.promise.catch(() => undefined);
        } else {
          cancellation.resolve();
          await expect(cancel.mock.results[0]?.value).resolves.toBeUndefined();
        }
      } finally {
        cancellation.resolve();
        await missing;
      }
    },
  );

  it.each([401, 403])("still awaits final credential rejection cleanup (%s)", async (status) => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const cancellation = createDeferred();
    const cancel = vi.fn(() => cancellation.promise);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status }));
    const settled = vi.fn();
    const pending = Promise.resolve(resolveAvatarImageUrl("/api/users/profile-ada/avatar"));
    void pending.then(settled);
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();
      cancellation.resolve();
      await expect(pending).resolves.toBeNull();
      expect(fetchAvatar).toHaveBeenCalledOnce();
    } finally {
      cancellation.resolve();
      await pending;
    }
  });

  it("keeps active avatar requests valid when a roster exceeds the cache limit", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const finishRequests: Array<(response: Response) => void> = [];
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        await new Promise<Response>((resolve) => {
          finishRequests.push(resolve);
        }),
    );
    let blobIndex = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:profile-${blobIndex++}`);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

    const pending = Array.from({ length: 130 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/api/users/profile-${index}/avatar?v=1`)),
    );
    const releases = pending.map((request) => retainAvatarImageUrl(request));
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledTimes(130));
    for (const finishRequest of finishRequests) {
      finishRequest(avatarResponse());
    }

    const imageUrls = await Promise.all(pending);
    expect(imageUrls).toHaveLength(130);
    expect(imageUrls.every((url) => url?.startsWith("blob:profile-"))).toBe(true);
    expect(new Set(imageUrls).size).toBe(130);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    releases[0]?.();
    releases[1]?.();

    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, imageUrls[0]);
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, imageUrls[1]);
  });

  it("keeps a shared pane image live until its last reference becomes evictable", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => avatarResponse());
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:retained-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const pending = resolveAvatarImageUrl("/avatar/main?v=1");
    const releaseMain = retainAvatarImageUrl(pending);
    const releaseSidebar = retainAvatarImageUrl(pending);
    const first = await pending;
    const fill = async (start: number) => {
      for (let index = start; index < start + 128; index += 1) {
        const imageRequest = resolveAvatarImageUrl(`/avatar/agent-${index}?v=1`);
        const release = retainAvatarImageUrl(imageRequest);
        await imageRequest;
        release();
      }
    };
    await fill(0);
    releaseMain();
    await fill(128);
    expect(revoke).not.toHaveBeenCalledWith(first);
    releaseSidebar();
    await fill(256);
    expect(revoke).toHaveBeenCalledWith(first);
  });

  it("evicts settled misses in LRU order without retrying retained avatars", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    const fetchAvatar = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

    const pending = Array.from({ length: 130 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/api/users/profile-${index}/avatar`)),
    );
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 130 }, () => null));
    expect(resolveAvatarImageUrl("/api/users/profile-129/avatar")).toBeNull();
    expect(fetchAvatar).toHaveBeenCalledTimes(130);

    await expect(resolveAvatarImageUrl("/api/users/profile-0/avatar")).resolves.toBeNull();
    expect(fetchAvatar).toHaveBeenCalledTimes(131);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("rejects non-image responses from the authenticated avatar endpoint", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token"]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not an image", { headers: { "content-type": "text/html" } }),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["first", "secondary"])(
    "revokes cached blobs after the %s credential changes",
    async (position) => {
      const before = position === "first" ? ["first-token"] : ["same-token", "first-password"];
      const after = position === "first" ? ["second-token"] : ["same-token", "second-password"];
      setAvatarGatewayOrigin("https://gateway.example.test", before);
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => avatarResponse());
      vi.spyOn(URL, "createObjectURL")
        .mockReturnValueOnce("blob:first-profile")
        .mockReturnValueOnce("blob:second-profile");
      const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

      await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
        "blob:first-profile",
      );
      setAvatarGatewayOrigin("https://gateway.example.test", after);
      await expect(resolveAvatarImageUrl("/api/users/profile-ada/avatar?v=7")).resolves.toBe(
        "blob:second-profile",
      );

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-profile");
      expect(fetchAvatar).toHaveBeenLastCalledWith(
        "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
        expect.objectContaining({ headers: { Authorization: `Bearer ${after[0]}` } }),
      );
    },
  );

  it("never retries a saved secret after its credential context was replaced", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["same-token", "old-password"]);
    const request = createDeferred<Response>();
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);
    const pending = resolveAvatarImageUrl("/api/users/profile-ada/avatar");
    await vi.waitFor(() => expect(fetchAvatar).toHaveBeenCalledOnce());
    const signal = fetchAvatar.mock.calls[0]?.[1]?.signal;
    setAvatarGatewayOrigin("https://gateway.example.test", ["same-token", "new-password"]);
    expect(signal?.aborted).toBe(true);
    request.resolve(new Response(null, { status: 401 }));
    await expect(pending).resolves.toBeNull();
    expect(fetchAvatar).toHaveBeenCalledOnce();
  });

  it("never forwards gateway credentials to a sender-controlled avatar origin", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["profile-token", "profile-password"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch");

    for (const avatarUrl of [
      "https://evil.example/api/users/profile-ada/avatar?v=7",
      "https://gateway.example.test.evil.example/api/users/profile-ada/avatar?v=7",
      "https://gateway.example.test@evil.example/api/users/profile-ada/avatar?v=7",
      "//evil.example/api/users/profile-ada/avatar?v=7",
      "/api/secrets",
      "https://evil.example/avatar/research",
      "//evil.example/avatar/research",
      "/avatar/research/extra",
      "/avatar/%",
    ]) {
      expect(resolveAvatarImageUrl(avatarUrl)).toBeNull();
      expect(resolveAvatar({ id: "profile-ada", profileAvatarUrl: avatarUrl })).toMatchObject({
        kind: "initials",
      });
    }
    expect(fetchAvatar).not.toHaveBeenCalled();
  });
});
