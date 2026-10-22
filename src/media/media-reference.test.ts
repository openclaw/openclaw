import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  expect(mediaError).toMatchObject({ name: "MediaReferenceError", code: expectedCode });
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

function expectClassification(
  source: string,
  overrides: Partial<ReturnType<typeof classifyMediaReferenceSource>>,
  allowDataUrl = true,
) {
  expect(classifyMediaReferenceSource(source, { allowDataUrl })).toStrictEqual({
    hasUnsupportedScheme: false,
    isDataUrl: false,
    isFileUrl: false,
    isHttpUrl: false,
    isMediaStoreUrl: false,
    looksLikeWindowsDrivePath: false,
    ...overrides,
  });
}

describe("media reference helpers", () => {
  it("classifies supported and unsupported media reference schemes", () => {
    expectClassification("media://inbound/a.png", { isMediaStoreUrl: true });
    expectClassification("data:image/png;base64,cG5n", { isDataUrl: true });
    expectClassification(
      "data:image/png;base64,cG5n",
      { isDataUrl: true, hasUnsupportedScheme: true },
      false,
    );
    expectClassification("ftp://example.test/a.png", { hasUnsupportedScheme: true });
    expectClassification("C:\\Users\\pete\\image.png", { looksLikeWindowsDrivePath: true });
  });

  it("resolves canonical inbound media URIs", async () => {
    const { id, source, physicalPath } = await createInboundFile();
    await expect(resolveInbound(source)).resolves.toStrictEqual({
      id,
      physicalPath,
    });
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
    const { source, physicalPath } = await createInboundFile();
    await expect(resolveMediaReferenceLocalPath(source)).resolves.toBe(physicalPath);
    await expect(resolveMediaReferenceLocalPathInfo(source)).resolves.toStrictEqual({
      kind: "inbound",
      path: physicalPath,
    });
    await expect(resolveMediaReferenceLocalPath("  MEDIA: ./out.png")).resolves.toBe("./out.png");
    await expect(resolveMediaReferenceLocalPathInfo("  MEDIA: ./out.png")).resolves.toStrictEqual({
      kind: "local",
      path: "./out.png",
    });
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
    expect(() => parseInboundMediaUri("media://inbound/nested%2Fa.png")).toThrow(
      MediaReferenceError,
    );
    expect(() => parseInboundMediaUri("media://inbound/%00.png")).toThrow(MediaReferenceError);
    for (const claim of [
      ["media://user", "password@inbound/claim.png"].join(":"),
      "media://inbound/claim.png?signature=private-secret",
      "media://inbound/claim.png#private-fragment",
    ]) {
      expect(() => parseInboundMediaUri(claim), claim).toThrow(MediaReferenceError);
    }
  });

  it("rejects symlinked inbound media files", async () => {
    const stateDir = resolveStateDir();
    const targetDir = path.join(stateDir, "media-reference-test-target");
    const targetPath = path.join(targetDir, "target.png");
    const id = makeId("ref-link");
    const linkPath = path.join(stateDir, "media", "inbound", id);
    cleanup.push(linkPath, targetDir);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from("png"));
    await fs.symlink(targetPath, linkPath);

    await expectMediaReferenceError(`media://inbound/${id}`, "invalid-path");
    await expectMediaReferenceError(linkPath, "invalid-path");
  });
});
