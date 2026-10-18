import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as imageOps from "../media/image-ops.js";
import { readImageMetadataFromHeader } from "../media/image-ops.js";
import { encodePngRgba } from "../media/png-encode.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-limits.js";
import {
  readGatewayAvatarNotificationIcon as readIcon,
  readGatewayAvatarThumbnail as readThumbnail,
} from "./assistant-avatar-thumbnail.runtime.js";
import { resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import { handleControlUiAvatarRequest } from "./control-ui.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const encodeDataUrl = (body: Buffer, mime = "image/png") =>
  `data:${mime};base64,${body.toString("base64")}`;
const png = (side: number, pixels: Buffer) => encodePngRgba(pixels, side, side);

function avatarFixture(basePath = "") {
  const workspace = tempRoots.make("openclaw-avatar-");
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
  const config: OpenClawConfig = {
    ...(basePath ? { gateway: { controlUi: { basePath } } } : {}),
    agents: { entries },
  };
  const auth = { mode: "token" as const, token: "test-token", allowTailscale: false };
  return {
    workspace,
    setAvatar(this: void, avatar: string | undefined, agentId = "main") {
      const identity = entries[agentId]?.identity;
      if (identity) {
        identity.avatar = avatar;
      } else {
        entries[agentId] = { workspace, identity: { avatar } };
      }
      setRuntimeConfigSnapshot(config);
    },
    async project(this: void, agentId = "main") {
      const { avatar } = await resolveGatewayAssistantAvatar({
        cfg: config,
        identity: await resolveAssistantIdentity({ cfg: config, agentId }),
        httpBasePath: basePath,
      });
      return avatar;
    },
    async request(this: void, url: string, method = "GET", etag?: string, authorized = true) {
      const response = makeMockHttpResponse();
      await handleControlUiAvatarRequest(
        {
          url,
          method,
          headers: {
            ...(basePath && authorized ? { authorization: "Bearer test-token" } : {}),
            ...(etag ? { "if-none-match": etag } : {}),
          },
          ...(basePath ? { socket: { remoteAddress: "127.0.0.1" } } : {}),
        } as IncomingMessage,
        response.res,
        { config, ...(basePath ? { basePath, auth } : {}) },
      );
      return response;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["https://example.test/avatar.png", "data:text/html,<html>avatar</html>"])(
  "rejects %s before invoking the native data decoder",
  async (dataUrl) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
    await expect(readThumbnail({ dataUrl, revision: `invalid:${dataUrl}` })).rejects.toThrow(
      "Unsupported avatar data URL",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("bounds decoded data bytes independently of the encoded URL limit", async () => {
  await expect(
    readThumbnail({
      dataUrl: `data:image/svg+xml,${"x".repeat(AVATAR_MAX_BYTES + 1)}`,
      revision: "oversized-svg",
    }),
  ).rejects.toThrow("Avatar data URL exceeds size limit");
});

it("coalesces concurrent thumbnail requests for the same admitted source", async () => {
  const gate = createDeferred();
  const decode = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
    await gate.promise;
    return decode(...args);
  });
  const sources = Array.from({ length: 5 }, (_, index) => ({
    dataUrl: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><text>${index}</text></svg>`,
    revision: `pending-svg-${index}`,
  }));
  const pending = sources.map(readThumbnail);
  pending.push(readThumbnail(sources[0]!));
  gate.resolve();
  const images = await Promise.all(pending);

  expect(fetch).toHaveBeenCalledTimes(5);
  expect(images[5]).toBe(images[0]);
});

it("retries failed thumbnail preparation without retaining the rejected result", async () => {
  const source = {
    dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    revision: "retry-svg",
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("decode failed"));
  await expect(readThumbnail(source)).rejects.toThrow("decode failed");
  const recovered = await readThumbnail(source);
  expect(await readThumbnail(source)).toBe(recovered);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("retries a failed notification image on the next delivery", async () => {
  const source = {
    dataUrl: encodeDataUrl(png(1, Buffer.from([255, 150, 0, 255]))),
    revision: "retry-notification-icon",
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("decode failed"));
  expect(await readIcon(source)).toBeUndefined();
  const icon = await readIcon(source);
  expect(icon).toMatch(/^data:image\/png;base64,/);
  expect(await readIcon(source)).toBe(icon);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps a detailed saved picker avatar within the notification image budget", async () => {
  const bytes = fs.readFileSync(new URL("./fixtures/notification-avatar.webp", import.meta.url));
  const icon = await readIcon({
    dataUrl: encodeDataUrl(bytes, "image/webp"),
    revision: "detailed-picker-avatar",
  });
  expect(icon).toMatch(/^data:image\/png;base64,/);
  expect(icon!.length).toBeLessThanOrEqual(2_400);
  const size = readImageMetadataFromHeader(Buffer.from(icon!.split(",")[1]!, "base64"));
  expect(size?.width).toBeLessThanOrEqual(32);
  expect(size?.height).toBeLessThanOrEqual(32);
});

// Two 2×2 red/blue frames encoded with img2webp; VP8X animation flag and timing are retained.
const ANIMATED_WEBP = Buffer.from(
  "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=",
  "base64",
);
const BMP_BYTES = Buffer.from(
  "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
  "base64",
);
const AVIF_BYTES = Buffer.from(
  "AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACgAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAwbWRhdBIACghYAAa0BDQbhDIaGUeHhiGJpppmgAAAkD+bDGFLK02PUUVOpCA=",
  "base64",
);

it.each([
  ["local", "image/apng", "avatar.png", APNG_BYTES],
  ["escaped-base64", "image/apng", undefined, APNG_BYTES],
  ["local", "image/webp", "avatar.webp", ANIMATED_WEBP],
  ["data", "image/webp", undefined, ANIMATED_WEBP],
  ["data", "image/bmp", undefined, BMP_BYTES],
  ["percent-data", "image/avif", undefined, AVIF_BYTES],
  [
    "percent-data",
    "image/svg+xml;charset=iso-8859-1",
    undefined,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>café</text></svg>', "latin1"),
  ],
] as const)("preserves the bytes of a %s %s avatar", async (sourceKind, mime, filename, body) => {
  const fixture = avatarFixture();
  if (filename) {
    fs.writeFileSync(path.join(fixture.workspace, filename), body);
  }
  const base64 = body.toString("base64");
  const avatar =
    sourceKind === "local"
      ? filename
      : sourceKind === "percent-data"
        ? `data:${mime},${Array.from(body, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("")}`
        : `data:${mime};base64,${sourceKind === "escaped-base64" ? encodeURIComponent(base64) : base64}`;
  fixture.setAvatar(avatar);
  const response = await fixture.request(await fixture.project());
  expect(response.res.statusCode).toBe(200);
  expect(response.end).toHaveBeenCalledWith(body);
  if (sourceKind !== "local") {
    expect(response.setHeader).toHaveBeenCalledWith("content-type", mime);
  }
});

it.each(["local", "data"])(
  "reuses authenticated thumbnails across five %s avatars until their source changes",
  async (sourceKind) => {
    const processor = imageOps.createImageProcessor();
    const encode = vi.spyOn(processor, "encode");
    vi.spyOn(imageOps, "createImageProcessor").mockReturnValue(processor);
    const { workspace, setAvatar, project, request } = avatarFixture("/control");
    const original = png(640, randomBytes(640 * 640 * 4));
    const avatarPath = path.join(workspace, "avatar.png");
    fs.writeFileSync(avatarPath, original);
    setAvatar(sourceKind === "local" ? "avatar.png" : encodeDataUrl(original));
    const url = await project();
    expect(url).toMatch(/^\/control\/avatar\/main\?v=[a-f0-9]+$/);
    const first = await request(url);
    expect(first.res.statusCode).toBe(200);
    const thumbnail = first.end.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(thumbnail)).toBe(true);
    expect(readImageMetadataFromHeader(thumbnail as Buffer)).toEqual({ width: 128, height: 128 });
    expect((thumbnail as Buffer).length).toBeLessThan(original.length / 10);
    const header = first.setHeader;
    expect(header).toHaveBeenCalledWith("cache-control", "private, max-age=31536000, immutable");
    expect(header).toHaveBeenCalledWith("vary", "Authorization, Cookie");
    const etag = header.mock.calls.find(([name]) => name === "etag")?.[1] as string;
    expect(etag).toBeTruthy();

    const urls = [url];
    for (let index = 1; index < 5; index += 1) {
      const agentId = `AvAtAr-${index}`;
      const filename = `${agentId}.png`;
      const bytes = png(160, Buffer.alloc(160 * 160 * 4, index * 40));
      fs.writeFileSync(path.join(workspace, filename), bytes);
      setAvatar(sourceKind === "local" ? filename : encodeDataUrl(bytes), agentId);
      urls.push(await project(agentId));
      expect((await request(urls[index]!)).res.statusCode).toBe(200);
    }
    expect(encode).toHaveBeenCalledTimes(5);
    for (const avatarUrl of urls) {
      expect((await request(avatarUrl)).res.statusCode).toBe(200);
    }
    expect(encode).toHaveBeenCalledTimes(5);

    const fileReads = (["read", "openSync", "realpathSync", "readFileSync"] as const).map(
      (method) => vi.spyOn(fs, method),
    );
    const cached = await request(url);
    expect(cached.end).toHaveBeenCalledWith(thumbnail);
    const head = await request(url, "HEAD");
    expect(head.setHeader).toHaveBeenCalledWith(
      "content-length",
      String((thumbnail as Buffer).length),
    );
    expect(head.end.mock.calls[0]?.[0]).toBeUndefined();
    expect((await request(url, "GET", etag)).res.statusCode).toBe(304);
    expect((await request(url, "GET", etag, false)).res.statusCode).toBe(401);
    for (const read of fileReads) {
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
    }

    const replacement = png(640, Buffer.alloc(640 * 640 * 4, 120));
    if (sourceKind === "local") {
      fs.writeFileSync(path.join(workspace, "replacement.png"), replacement);
      fs.renameSync(path.join(workspace, "replacement.png"), avatarPath);
    } else {
      setAvatar(encodeDataUrl(replacement));
    }
    const replacedUrl = await project();
    expect(replacedUrl).not.toBe(url);
    const replaced = await request(replacedUrl, "GET", etag);
    expect(replaced.res.statusCode).toBe(200);
    expect(encode).toHaveBeenCalledTimes(6);
    expect(replaced.end.mock.calls[0]?.[0]).not.toEqual(thumbnail);
    const stale = await request(url);
    expect(stale.setHeader).toHaveBeenCalledWith("cache-control", "private, no-cache");
  },
);
