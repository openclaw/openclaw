import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import {
  classifyMediaReferenceSource,
  MediaReferenceError,
  parseInboundMediaUri,
  resolveInboundMediaReference as resolveInbound,
  resolveMediaReferenceLocalPath,
  resolveMediaReferenceLocalPathInfo,
  resolveMediaReferenceSandboxPath,
} from "./media-reference.js";

async function expectMediaReferenceError(
  source: string,
  expectedCode: MediaReferenceError["code"],
) {
  const mediaError: unknown = await resolveInbound(source).catch((error: unknown) => error);
  expect(mediaError).toBeInstanceOf(MediaReferenceError);
  expect(mediaError).toMatchObject({ code: expectedCode });
}

const inboundPath = (id: string) => path.join(resolveStateDir(), "media", "inbound", id);
const makeId = (prefix = "ref") =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })));
});

async function createInboundFile(id = makeId()) {
  const file = inboundPath(id);
  cleanup.push(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from("png"));
  return { id, file, source: `media://inbound/${id}`, physicalPath: await fs.realpath(file) };
}

it("classifies supported and unsupported media reference schemes", () => {
  for (const [source, allowDataUrl, expected] of [
    ["media://inbound/a.png", true, { isMediaStoreUrl: true, hasUnsupportedScheme: false }],
    ["data:image/png;base64,cG5n", true, { isDataUrl: true, hasUnsupportedScheme: false }],
    ["data:image/png;base64,cG5n", false, { hasUnsupportedScheme: true, isDataUrl: true }],
    ["ftp://example.test/a.png", true, { hasUnsupportedScheme: true }],
    [
      "C:\\Users\\pete\\image.png",
      true,
      { looksLikeWindowsDrivePath: true, hasUnsupportedScheme: false },
    ],
  ] as const) {
    expect(classifyMediaReferenceSource(source, { allowDataUrl })).toMatchObject(expected);
  }
});

it("parses inbound media URIs for sandbox-relative staging", () => {
  expect(parseInboundMediaUri("MEDIA: media://inbound/photo.png")).toStrictEqual({
    id: "photo.png",
    normalizedSource: "media://inbound/photo.png",
  });
  expect(resolveMediaReferenceSandboxPath("media://inbound/photo.png")).toStrictEqual({
    resolved: "media/inbound/photo.png",
    rewrittenFrom: "media://inbound/photo.png",
  });
  expect(resolveMediaReferenceSandboxPath("MEDIA: ./out.png")).toStrictEqual({
    resolved: "./out.png",
  });
});

it("maps canonical inbound media URIs to local paths for direct file readers", async () => {
  const { id, source, physicalPath } = await createInboundFile();
  await expect(resolveInbound(source)).resolves.toStrictEqual({ id, physicalPath });
  for (const [input, expected] of [
    [source, { kind: "inbound", path: physicalPath }],
    ["  MEDIA: ./out.png", { kind: "local", path: "./out.png" }],
  ] as const) {
    await expect(resolveMediaReferenceLocalPath(input)).resolves.toBe(expected.path);
    await expect(resolveMediaReferenceLocalPathInfo(input)).resolves.toStrictEqual(expected);
  }
});

it("resolves direct absolute paths only for first-level inbound media files", async () => {
  const stateDir = resolveStateDir();
  const ids = [makeId("ref-path"), makeId("..ref-path")] as const;
  for (const { id, file, physicalPath } of await Promise.all(ids.map(createInboundFile))) {
    await expect(resolveInbound(file)).resolves.toStrictEqual({ id, physicalPath });
  }
  await expect(resolveInbound(inboundPath(path.join("nested", ids[0])))).resolves.toBeNull();
  await expect(
    resolveInbound(path.join(stateDir, "media", "outbound", ids[0])),
  ).resolves.toBeNull();
});

it("rejects inbound media URIs with unsupported locations or unsafe ids", async () => {
  for (const [source, code] of [
    ["media://outbound/a.png", "path-not-allowed"],
    ["media://inbound/nested%2Fa.png", "invalid-path"],
    ["media://inbound/", "invalid-path"],
    ["media://inbound/%00.png", "invalid-path"],
  ] as const) {
    await expectMediaReferenceError(source, code);
  }
  for (const claim of [
    ["media://user", "password@inbound/claim.png"].join(":"),
    "media://inbound/claim.png?signature=private-secret",
    "media://inbound/claim.png#private-fragment",
  ]) {
    expect(() => parseInboundMediaUri(claim), claim).toThrow(MediaReferenceError);
  }
});

it("rejects symlinked inbound media files", async () => {
  const targetPath = path.join(resolveStateDir(), makeId("target"));
  const id = makeId("ref-link");
  const linkPath = inboundPath(id);
  cleanup.push(linkPath, targetPath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from("png"));
  await fs.symlink(targetPath, linkPath);

  await expectMediaReferenceError(`media://inbound/${id}`, "invalid-path");
  await expectMediaReferenceError(linkPath, "invalid-path");
});
