import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  WORKSPACE_PREVIEW_MAX_BYTES,
} from "../workspace-file-limits.js";
import { getSessionWorkspaceFile } from "./workspace-files.js";
import type { WorkspaceRoot } from "./workspace-fs.js";

// Remote-bridge simulation: a registered remote root reports "unsupported"
// for prefix reads (an oversized remote file must not be downloaded just to
// sniff it), while full reads still honor the caller's maxBytes. The flag
// toggles the mock for the remote-parity tests; all other calls delegate to
// the real implementation.
const prefixReadState = vi.hoisted(() => ({ remoteBridge: false }));

vi.mock("./workspace-fs.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workspace-fs.js")>();
  return {
    ...original,
    readWorkspaceFilePrefix: vi.fn(
      async (rootDir: string | WorkspaceRoot, browserPath: string, maxBytes: number) => {
        if (prefixReadState.remoteBridge) {
          return "unsupported";
        }
        return original.readWorkspaceFilePrefix(rootDir, browserPath, maxBytes);
      },
    ),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(vi.restoreAllMocks);

const TEXT_CAP = WORKSPACE_PREVIEW_MAX_BYTES;
const IMAGE_CAP = WORKSPACE_IMAGE_PREVIEW_MAX_BYTES;

// CRC-32 (reflected, poly 0xEDB88320) — PNG chunk framing. file-type never
// validates CRCs, but well-formed chunks keep fixtures honest.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Minimal valid PNG (file-type v22 requires signature + IHDR + IDAT). The
 * private ancillary "pDAT" chunk's payload size pins the exact total byte
 * count, which makes cap-boundary fixtures precise.
 */
function buildPng(totalBytes: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); // width
  ihdrData.writeUInt32BE(1, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  const ihdr = pngChunk("IHDR", ihdrData);
  const idat = pngChunk("IDAT", deflateSync(Buffer.from([1, 2, 3, 4])));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  const padLength = totalBytes - (signature.length + ihdr.length + idat.length + iend.length);
  if (padLength < 12) {
    throw new Error(`buildPng: target too small (${totalBytes} bytes)`);
  }
  const pdat = pngChunk("pDAT", randomBytes(padLength - 12));
  return Buffer.concat([signature, ihdr, pdat, idat, iend]);
}

async function putFile(dir: string, rel: string, bytes: Buffer): Promise<void> {
  await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(dir, rel), bytes);
}

async function getEntry(dir: string, rel: string) {
  const result = await getSessionWorkspaceFile({ root: dir, fileRoot: dir, files: [], path: rel });
  expect(result.root).toBe(dir);
  expect(result.file?.missing).toBe(false);
  return result.file!;
}

describe("workspace file preview caps", () => {
  it("inlines the user's 1.7 MB PNG as an image preview instead of 'not previewable'", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const rel = "晨雪光v1_事实核对.png";
    const target = 1_703_501; // exact byte count of the reported file
    const png = buildPng(target);
    await putFile(dir, rel, png);

    const file = await getEntry(dir, rel);
    expect(file.size).toBe(target);
    expect(file.previewKind).toBe("image");
    expect(file.mimeType).toBe("image/png");
    expect(file.contentEncoding).toBe("base64");
    expect(Buffer.from(file.content!, "base64").equals(png)).toBe(true);
  });

  it("inlines a PNG at exactly the 5 MiB image cap (inclusive boundary)", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const rel = "sub/exact-cap.png";
    const png = buildPng(IMAGE_CAP);
    await putFile(dir, rel, png);

    const file = await getEntry(dir, rel);
    expect(file.size).toBe(IMAGE_CAP);
    expect(file.previewKind).toBe("image");
    expect(file.mimeType).toBe("image/png");
    expect(Buffer.from(file.content!, "base64").equals(png)).toBe(true);
  });

  it("marks a 5 MiB + 1 PNG as unsupported while still detecting image/png", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const rel = "over-cap.png";
    await putFile(dir, rel, buildPng(IMAGE_CAP + 1));

    const file = await getEntry(dir, rel);
    expect(file.size).toBe(IMAGE_CAP + 1);
    expect(file.previewKind).toBe("unsupported");
    expect(file.mimeType).toBe("image/png");
    expect(file.content).toBeUndefined();
    expect(file.hash).toBeUndefined();
  });

  it("keeps the 256 KiB cap for non-image files", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");

    // Under the text cap: inline utf8 preview with the CAS hash (unchanged).
    const smallRel = "small.txt";
    const smallText = "hello openclaw\n".repeat(2560); // ~30 KiB
    await putFile(dir, smallRel, Buffer.from(smallText, "utf8"));
    const small = await getEntry(dir, smallRel);
    expect(small.previewKind).toBe("text");
    expect(small.contentEncoding).toBe("utf8");
    expect(small.content).toBe(smallText);
    expect(small.mimeType).toBe("text/plain");
    expect(small.hash).toBe(createHash("sha256").update(smallText).digest("hex"));

    // Just over the text cap: legacy prefix-sniff path — no inline content is
    // produced for text prefixes, and this must stay byte-identical to upstream.
    const bigRel = "big.txt";
    await putFile(dir, bigRel, Buffer.alloc(TEXT_CAP + 1, 0x61));
    const big = await getEntry(dir, bigRel);
    expect(big.size).toBe(TEXT_CAP + 1);
    expect(big.previewKind).toBeUndefined();
    expect(big.content).toBeUndefined();

    // Over-cap binary: detected as non-text, marked unsupported without content.
    const binRel = "blob.bin";
    const bin = Buffer.alloc(300 * 1024);
    bin[0] = 0xff;
    bin[1] = 0xfe;
    await putFile(dir, binRel, bin);
    const binEntry = await getEntry(dir, binRel);
    expect(binEntry.size).toBe(300 * 1024);
    expect(binEntry.previewKind).toBe("unsupported");
    expect(binEntry.content).toBeUndefined();
  });

  it("denies the image cap to a .png that actually contains UTF-8 text", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");

    // Over the text cap: the prefix sniff rejects the image cap, so the file
    // follows the legacy prefix-sniff path: no inline content and no CAS
    // edit hash (byte-identical to upstream behavior for 300 KiB text).
    const unit = "晨雪光 事实核对\n";
    const repeats = Math.ceil((300 * 1024) / Buffer.byteLength(unit, "utf8"));
    const text = unit.repeat(repeats);
    const textBytes = Buffer.byteLength(text, "utf8");
    expect(textBytes).toBeGreaterThan(TEXT_CAP);
    expect(textBytes).toBeLessThan(IMAGE_CAP);
    await putFile(dir, "report.png", Buffer.from(text, "utf8"));
    const file = await getEntry(dir, "report.png");
    expect(file.size).toBe(textBytes);
    expect(file.previewKind).toBeUndefined();
    expect(file.content).toBeUndefined();
    expect(file.hash).toBeUndefined();

    // Under the text cap: still a normal utf8 text preview with edit hash.
    const smallText = "png 文件其实是文本\n".repeat(100);
    await putFile(dir, "tiny.png", Buffer.from(smallText, "utf8"));
    const small = await getEntry(dir, "tiny.png");
    expect(small.previewKind).toBe("text");
    expect(small.content).toBe(smallText);
    expect(small.hash).toBe(createHash("sha256").update(smallText).digest("hex"));
  });
  it("keeps the text cap for a remote .png of UTF-8 text when prefix sniffing is unsupported", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const unit = "晨雪光 事实核对\n";
    const repeats = Math.ceil((300 * 1024) / Buffer.byteLength(unit, "utf8"));
    const text = unit.repeat(repeats);
    const textBytes = Buffer.byteLength(text, "utf8");
    expect(textBytes).toBeGreaterThan(TEXT_CAP);
    expect(textBytes).toBeLessThan(IMAGE_CAP);
    await putFile(dir, "report.png", Buffer.from(text, "utf8"));

    // Remote parity: main returns a preview-limited entry for this file
    // (no inline content, no CAS edit hash); the 5 MiB image cap must not
    // apply where content verification is unavailable.
    prefixReadState.remoteBridge = true;
    try {
      const file = await getEntry(dir, "report.png");
      expect(file.size).toBe(textBytes);
      expect(file.previewKind).toBeUndefined();
      expect(file.content).toBeUndefined();
      expect(file.hash).toBeUndefined();
    } finally {
      prefixReadState.remoteBridge = false;
    }
  });

  it("keeps a remote 1.7 MB PNG at the generic cap when prefix sniffing is unsupported", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const target = 1_703_501;
    await putFile(dir, "remote.png", buildPng(target));

    prefixReadState.remoteBridge = true;
    try {
      const file = await getEntry(dir, "remote.png");
      expect(file.size).toBe(target);
      expect(file.previewKind).toBeUndefined();
      expect(file.content).toBeUndefined();
      expect(file.mimeType).toBeUndefined();
    } finally {
      prefixReadState.remoteBridge = false;
    }
  });

  it("still inlines a remote image below the generic cap when prefix sniffing is unsupported", async () => {
    const dir = tempDirs.make("openclaw-workspace-preview-cap-");
    const rel = "small-remote.png";
    const png = buildPng(180 * 1024);
    await putFile(dir, rel, png);

    prefixReadState.remoteBridge = true;
    try {
      const file = await getEntry(dir, rel);
      expect(file.size).toBe(180 * 1024);
      expect(file.previewKind).toBe("image");
      expect(file.mimeType).toBe("image/png");
      expect(file.contentEncoding).toBe("base64");
      expect(Buffer.from(file.content!, "base64").equals(png)).toBe(true);
    } finally {
      prefixReadState.remoteBridge = false;
    }
  });
});
