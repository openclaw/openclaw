import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { loadWebMedia } from "./web-media.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

let fixtureRoot = "";
let tinyPngFile = "";

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "web-media-core-"));
  tinyPngFile = path.join(fixtureRoot, "tiny.png");
  await fs.writeFile(tinyPngFile, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe("loadWebMedia", () => {
  it("allows localhost file URLs for local files", async () => {
    const fileUrl = pathToFileURL(tinyPngFile);
    fileUrl.hostname = "localhost";

    const result = await loadWebMedia(fileUrl.href, {
      maxBytes: 1024 * 1024,
      localRoots: [fixtureRoot],
    });

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it("rejects remote-host file URLs before filesystem checks", async () => {
    const realpathSpy = vi.spyOn(fs, "realpath");

    try {
      await expect(
        loadWebMedia("file://attacker/share/evil.png", {
          maxBytes: 1024 * 1024,
          localRoots: [fixtureRoot],
        }),
      ).rejects.toMatchObject({ code: "invalid-file-url" });
      await expect(
        loadWebMedia("file://attacker/share/evil.png", {
          maxBytes: 1024 * 1024,
          localRoots: [fixtureRoot],
        }),
      ).rejects.toThrow(/remote hosts are not allowed/i);
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("rejects Windows network paths before filesystem checks", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const realpathSpy = vi.spyOn(fs, "realpath");

    try {
      await expect(
        loadWebMedia("\\\\attacker\\share\\evil.png", {
          maxBytes: 1024 * 1024,
          localRoots: [fixtureRoot],
        }),
      ).rejects.toMatchObject({ code: "network-path-not-allowed" });
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });
});
