import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractLcmImageFileReference,
  resolveLcmFilesRoot,
  resolveLcmImageFileReference,
} from "./lcm-file-reference.js";

describe("LCM file references", () => {
  it("extracts only strict file_<16hex> image refs", () => {
    expect(extractLcmImageFileReference("[file_ref:file_0123456789abcdef]")).toBe(
      "file_0123456789abcdef",
    );
    expect(extractLcmImageFileReference("[externalized file_fedcba9876543210]")).toBe(
      "file_fedcba9876543210",
    );
    expect(extractLcmImageFileReference("file_abc")).toBeNull();
    expect(extractLcmImageFileReference("/tmp/file_0123456789abcdef.webp")).toBeNull();
  });

  it("resolves one-level LCM image files under the managed state root", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-ref-"));
    const lcmRoot = resolveLcmFilesRoot(stateDir);
    const conversationDir = path.join(lcmRoot, "conversation-a");
    const fileRef = "file_0123456789abcdef";
    const imagePath = path.join(conversationDir, `${fileRef}.webp`);
    await fs.mkdir(conversationDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from("image"));

    try {
      await expect(resolveLcmImageFileReference(`[file_ref:${fileRef}]`, { stateDir })).resolves
        .toStrictEqual({
          fileRef,
          path: await fs.realpath(imagePath),
          root: await fs.realpath(lcmRoot),
        });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not resolve non-image extensions or missing roots", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-ref-miss-"));
    const lcmRoot = resolveLcmFilesRoot(stateDir);
    const conversationDir = path.join(lcmRoot, "conversation-a");
    const fileRef = "file_0123456789abcdef";
    await fs.mkdir(conversationDir, { recursive: true });
    await fs.writeFile(path.join(conversationDir, `${fileRef}.txt`), "not an image");

    try {
      await expect(resolveLcmImageFileReference(fileRef, { stateDir })).resolves.toBeNull();
      await expect(
        resolveLcmImageFileReference(fileRef, {
          stateDir: path.join(stateDir, "missing"),
        }),
      ).resolves.toBeNull();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not guess when an LCM image file reference is ambiguous", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-ref-ambiguous-"));
    const lcmRoot = resolveLcmFilesRoot(stateDir);
    const fileRef = "file_0123456789abcdef";
    await fs.mkdir(path.join(lcmRoot, "conversation-a"), { recursive: true });
    await fs.mkdir(path.join(lcmRoot, "conversation-b"), { recursive: true });
    await fs.writeFile(path.join(lcmRoot, "conversation-a", `${fileRef}.webp`), Buffer.from("a"));
    await fs.writeFile(path.join(lcmRoot, "conversation-b", `${fileRef}.webp`), Buffer.from("b"));

    try {
      await expect(resolveLcmImageFileReference(fileRef, { stateDir })).resolves.toBeNull();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
