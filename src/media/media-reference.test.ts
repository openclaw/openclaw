import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
async function createInboundFile(id: string) {
  const filePath = inboundPath(id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from("png"));
  return filePath;
}

function expectClassification(
  source: string,
  overrides: Partial<ReturnType<typeof classifyMediaReferenceSource>>,
  allowDataUrl = true,
) {
  expect(classifyMediaReferenceSource(source, { allowDataUrl })).toStrictEqual({
    hasScheme: true,
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
    const stateDir = resolveStateDir();
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));
    const realFilePath = await fs.realpath(filePath);

    try {
      await expect(resolveInbound(`media://inbound/${id}`)).resolves.toStrictEqual({
        id,
        normalizedSource: `media://inbound/${id}`,
        physicalPath: realFilePath,
        sourceType: "uri",
      });
    } finally {
      await fs.rm(filePath, { force: true });
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
    const id = `ref-local-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = await createInboundFile(id);
    const realFilePath = await fs.realpath(filePath);

    try {
      await expect(resolveMediaReferenceLocalPath(`media://inbound/${id}`)).resolves.toBe(
        realFilePath,
      );
      await expect(
        resolveMediaReferenceLocalPathInfo(`media://inbound/${id}`),
      ).resolves.toStrictEqual({ kind: "inbound", path: realFilePath });
      await expect(resolveMediaReferenceLocalPath("  MEDIA: ./out.png")).resolves.toBe("./out.png");
      await expect(resolveMediaReferenceLocalPathInfo("  MEDIA: ./out.png")).resolves.toStrictEqual(
        { kind: "local", path: "./out.png" },
      );
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("resolves direct absolute paths only for first-level inbound media files", async () => {
    const stateDir = resolveStateDir();
    const ids = [
      `ref-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
      `..ref-path-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    ] as const;
    const filePaths = await Promise.all(ids.map(createInboundFile));

    try {
      for (const id of ids) {
        const filePath = inboundPath(id);
        await expect(resolveInbound(filePath)).resolves.toStrictEqual({
          id,
          normalizedSource: filePath,
          physicalPath: await fs.realpath(filePath),
          sourceType: "path",
        });
      }
      await expect(resolveInbound(inboundPath(path.join("nested", ids[0])))).resolves.toBeNull();
      await expect(
        resolveInbound(path.join(stateDir, "media", "outbound", ids[0])),
      ).resolves.toBeNull();
    } finally {
      await Promise.all(filePaths.map((filePath) => fs.rm(filePath, { force: true })));
    }
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
    const id = `ref-link-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const linkPath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from("png"));
    await fs.symlink(targetPath, linkPath);

    try {
      await expectMediaReferenceError(`media://inbound/${id}`, "invalid-path");
      await expectMediaReferenceError(linkPath, "invalid-path");
    } finally {
      await fs.rm(linkPath, { force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
