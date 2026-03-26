import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistBrowserProxyFiles } from "../../extensions/browser/src/browser/proxy-files.js";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("persistBrowserProxyFiles", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-browser-proxy-files-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("persists browser proxy files under the shared media store", async () => {
    const sourcePath = "/tmp/proxy-file.txt";
    const mapping = await persistBrowserProxyFiles([
      {
        path: sourcePath,
        base64: Buffer.from("hello from browser proxy").toString("base64"),
        mimeType: "text/plain",
      },
    ]);

    const savedPath = mapping.get(sourcePath);
    expect(typeof savedPath).toBe("string");
    expect(path.normalize(savedPath ?? "")).toContain(
      `${path.sep}.openclaw${path.sep}media${path.sep}browser${path.sep}`,
    );
    await expect(fs.readFile(savedPath ?? "", "utf8")).resolves.toBe("hello from browser proxy");
  });

  it("rejects browser proxy files that exceed the shared media size limit", async () => {
    const oversized = Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41);

    await expect(
      persistBrowserProxyFiles([
        {
          path: "/tmp/oversized.bin",
          base64: oversized.toString("base64"),
          mimeType: "application/octet-stream",
        },
      ]),
    ).rejects.toThrow("Media exceeds 5MB limit");

    await expect(
      fs.stat(path.join(tempHome.home, ".openclaw", "media", "browser")),
    ).rejects.toThrow();
  });
});
