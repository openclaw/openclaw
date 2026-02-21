import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("resolveOutboundAttachmentFromUrl", () => {
  let tempHome: TempHomeEnv;
  let home: string;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-outbound-attachment-");
    home = tempHome.home;
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } catch {
      // ignore cleanup failures
    }
  });

  it("preserves original filename in saved path", async () => {
    const srcDir = path.join(home, "files");
    await fs.mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "MyDocument.txt");
    await fs.writeFile(srcFile, "hello world");

    const { resolveOutboundAttachmentFromUrl } = await import("./outbound-attachment.js");

    const result = await resolveOutboundAttachmentFromUrl(srcFile, 5 * 1024 * 1024, {
      localRoots: [srcDir],
    });

    const basename = path.basename(result.path);
    expect(basename).toMatch(/^MyDocument---[a-f0-9-]{36}\.txt$/);
  });

  it("handles files without extension", async () => {
    const srcDir = path.join(home, "files");
    await fs.mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "Makefile");
    await fs.writeFile(srcFile, "all: build");

    const { resolveOutboundAttachmentFromUrl } = await import("./outbound-attachment.js");

    const result = await resolveOutboundAttachmentFromUrl(srcFile, 5 * 1024 * 1024, {
      localRoots: [srcDir],
    });

    const basename = path.basename(result.path);
    expect(basename).toContain("Makefile");
  });
});
