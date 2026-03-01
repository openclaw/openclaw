import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const getMessageContentMock = vi.hoisted(() => vi.fn());

vi.mock("@line/bot-sdk", () => ({
  messagingApi: {
    MessagingApiBlobClient: class {
      getMessageContent(messageId: string) {
        return getMessageContentMock(messageId);
      }
    },
  },
}));

vi.mock("../globals.js", () => ({
  logVerbose: () => {},
}));

import { downloadLineMedia } from "./download.js";

// Helper to create MP4/M4A ftyp box
function createMP4Buffer(brand: string): Buffer {
  // MP4 header: 4 bytes size + "ftyp" + 4 bytes brand + rest
  const size = 32;
  const buffer = Buffer.alloc(size);
  // Size (big-endian)
  buffer[0] = (size >> 24) & 0xff;
  buffer[1] = (size >> 16) & 0xff;
  buffer[2] = (size >> 8) & 0xff;
  buffer[3] = size & 0xff;
  // "ftyp"
  buffer[4] = 0x66;
  buffer[5] = 0x74;
  buffer[6] = 0x79;
  buffer[7] = 0x70;
  // Brand (4 bytes)
  for (let i = 0; i < brand.length; i++) {
    buffer[8 + i] = brand.charCodeAt(i);
  }
  return buffer;
}

async function* chunks(parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield part;
  }
}

describe("downloadLineMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not derive temp file path from external messageId", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    getMessageContentMock.mockResolvedValueOnce(chunks([jpeg]));

    const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia(messageId, "token");
    const writtenPath = writeSpy.mock.calls[0]?.[0];

    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    expect(typeof writtenPath).toBe("string");
    if (typeof writtenPath !== "string") {
      throw new Error("expected string temp file path");
    }
    expect(result.path).toBe(writtenPath);
    expect(writtenPath).toContain("line-media-");
    expect(writtenPath).toMatch(/\.jpg$/);
    expect(writtenPath).not.toContain(messageId);
    expect(writtenPath).not.toContain("..");

    const tmpRoot = path.resolve(resolvePreferredOpenClawTmpDir());
    const rel = path.relative(tmpRoot, path.resolve(writtenPath));
    expect(rel === ".." || rel.startsWith(`..${path.sep}`)).toBe(false);
  });

  it("rejects oversized media before writing to disk", async () => {
    getMessageContentMock.mockResolvedValueOnce(chunks([Buffer.alloc(4), Buffer.alloc(4)]));
    const writeSpy = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("detects M4A audio with M4A brand", async () => {
    const m4a = createMP4Buffer("M4A ");
    getMessageContentMock.mockResolvedValueOnce(chunks([m4a]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid", "token");
    expect(result.contentType).toBe("audio/mp4");
    expect(result.path).toMatch(/\.m4a$/);
  });

  it("detects M4A audio with isom brand", async () => {
    const isom = createMP4Buffer("isom");
    getMessageContentMock.mockResolvedValueOnce(chunks([isom]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid", "token");
    expect(result.contentType).toBe("audio/mp4");
    expect(result.path).toMatch(/\.m4a$/);
  });

  it("detects video/mp4 with avc1 brand", async () => {
    const avc1 = createMP4Buffer("avc1");
    getMessageContentMock.mockResolvedValueOnce(chunks([avc1]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid", "token");
    expect(result.contentType).toBe("video/mp4");
    expect(result.path).toMatch(/\.mp4$/);
  });

  it("detects video/mp4 with mp41 brand", async () => {
    const mp41 = createMP4Buffer("mp41");
    getMessageContentMock.mockResolvedValueOnce(chunks([mp41]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid", "token");
    expect(result.contentType).toBe("video/mp4");
    expect(result.path).toMatch(/\.mp4$/);
  });

  it("detects M4A audio with M4AE brand (enhanced)", async () => {
    const m4ae = createMP4Buffer("M4AE");
    getMessageContentMock.mockResolvedValueOnce(chunks([m4ae]));
    vi.spyOn(fs.promises, "writeFile").mockResolvedValueOnce(undefined);

    const result = await downloadLineMedia("mid", "token");
    expect(result.contentType).toBe("audio/mp4");
    expect(result.path).toMatch(/\.m4a$/);
  });
});
