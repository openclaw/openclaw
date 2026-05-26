import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { assertLocalMediaAllowed } from "./local-media-access.js";

describe("assertLocalMediaAllowed", () => {
  it("allows managed inbound media paths before explicit root checks", async () => {
    const stateDir = resolveStateDir();
    const id = `managed-local-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const filePath = path.join(stateDir, "media", "inbound", id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).resolves.toBeUndefined();
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("does not allow nested inbound paths as managed media", async () => {
    const stateDir = resolveStateDir();
    const filePath = path.join(stateDir, "media", "inbound", "nested", "hidden.png");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
    } finally {
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("allows explicit inbound roots without treating them as local roots", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-root-"));
    const filePath = path.join(rootDir, "image.png");
    await fs.writeFile(filePath, Buffer.from("png"));

    try {
      await expect(assertLocalMediaAllowed(filePath, [])).rejects.toMatchObject({
        code: "path-not-allowed",
      });
      const realRootDir = await fs.realpath(rootDir);
      await expect(
        assertLocalMediaAllowed(filePath, [], { inboundRoots: [realRootDir] }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects inbound-looking paths that resolve through a symlinked root",
    async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-symlink-"));
      const realRoot = path.join(tmpDir, "real");
      const linkRoot = path.join(tmpDir, "link");
      const filePath = path.join(linkRoot, "image.png");
      await fs.mkdir(realRoot, { recursive: true });
      await fs.writeFile(path.join(realRoot, "image.png"), Buffer.from("png"));
      await fs.symlink(realRoot, linkRoot, "dir");

      try {
        await expect(
          assertLocalMediaAllowed(filePath, [], { inboundRoots: [linkRoot] }),
        ).rejects.toMatchObject({
          code: "path-not-allowed",
        });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
