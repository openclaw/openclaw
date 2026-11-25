import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createStagedMediaAttachmentResolver } from "./sessions-spawn-attachment-resolver.js";

const tempFiles: string[] = [];
afterEach(() => {
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

it("resolves only a host-issued staged media handle and preserves its declared envelope", async () => {
  const data = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const file = path.join(os.tmpdir(), `openclaw-spawn-image-${crypto.randomUUID()}.jpg`);
  tempFiles.push(file);
  fs.writeFileSync(file, data);
  const reference = {
    id: "file_upload",
    name: "match.jpg",
    mimeType: "image/jpeg",
    sizeBytes: data.byteLength,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
  const resolver = createStagedMediaAttachmentResolver(
    new Map([[reference.id, path.basename(file)]]),
    { workspaceDir: os.tmpdir() },
  );
  expect(resolver).toBeDefined();

  await expect(resolver!({ reference })).resolves.toMatchObject({ ...reference, data });
  await expect(
    resolver!({ reference: { ...reference, id: "not-issued" } }),
  ).resolves.toBeNull();
});

it("rejects bytes that are not independently recognized as an image", async () => {
  const data = Buffer.from("not an image");
  const file = path.join(os.tmpdir(), `openclaw-spawn-not-image-${crypto.randomUUID()}.jpg`);
  tempFiles.push(file);
  fs.writeFileSync(file, data);
  const reference = {
    id: "file_upload",
    name: "spoof.jpg",
    mimeType: "image/jpeg",
    sizeBytes: data.byteLength,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  };
  const resolver = createStagedMediaAttachmentResolver(
    new Map([[reference.id, path.basename(file)]]),
    { workspaceDir: os.tmpdir() },
  );

  await expect(resolver!({ reference })).resolves.toBeNull();
});
