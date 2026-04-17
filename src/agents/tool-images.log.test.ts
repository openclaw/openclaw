import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isSharpAvailable } from "../media/image-ops.js";

const { infoMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agents/tool-images",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { sanitizeContentBlocksImages } from "./tool-images.js";

async function createLargePng(): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  const width = 2001;
  const height = 8;
  const raw = Buffer.alloc(width * height * 3, 0x7f);
  return await sharp(raw, {
    raw: { width, height, channels: 3 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

const SHARP_AVAILABLE = await isSharpAvailable();

describe.runIf(SHARP_AVAILABLE)("tool-images log context", () => {
  let png: Buffer;

  beforeAll(async () => {
    png = await createLargePng();
  });

  beforeEach(() => {
    infoMock.mockClear();
    warnMock.mockClear();
  });

  it("includes filename from MEDIA text", async () => {
    const blocks = [
      { type: "text" as const, text: "MEDIA:/tmp/snapshots/camera-front.png" },
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    await sanitizeContentBlocksImages(blocks, "nodes:camera_snap");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.some((message) => message.includes("camera-front.png"))).toBe(true);
  });

  it("includes filename from read label", async () => {
    const blocks = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    await sanitizeContentBlocksImages(blocks, "read:/tmp/images/sample-diagram.png");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.some((message) => message.includes("sample-diagram.png"))).toBe(true);
  });
});
