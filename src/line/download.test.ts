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
});
