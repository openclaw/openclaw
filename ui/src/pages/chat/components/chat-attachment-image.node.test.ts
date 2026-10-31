// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { canResizeChatAttachment, resizeChatAttachmentImage } from "./chat-attachment-image.ts";

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(values);
}

function segment(marker: number, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const length = payload.length + 2;
  const out = new Uint8Array(2 + length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function sof(width: number, height: number, marker = 0xc0): Uint8Array<ArrayBuffer> {
  // precision(1) + height(2) + width(2) + components(1) + 3 component specs.
  const payload = new Uint8Array(15);
  payload[0] = 8;
  payload[1] = (height >> 8) & 0xff;
  payload[2] = height & 0xff;
  payload[3] = (width >> 8) & 0xff;
  payload[4] = width & 0xff;
  payload[5] = 3;
  return segment(marker, payload);
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SOI = bytes(0xff, 0xd8);
const SOS = bytes(0xff, 0xda);
const EOI = bytes(0xff, 0xd9);
const EXIF_APP1 = segment(0xe1, bytes(0x45, 0x78, 0x69, 0x66, 0x00, 0x00));

function jpegFile(data: Uint8Array<ArrayBuffer>, name = "photo.jpg"): File {
  return new File([data], name, { type: "image/jpeg" });
}

class MockWorker extends EventTarget {
  static created: MockWorker[] = [];
  terminate = vi.fn();
  complete(file: File) {
    this.dispatchEvent(new MessageEvent("message", { data: file }));
  }
  postMessage() {}
}

function stubWorker() {
  MockWorker.created = [];
  vi.stubGlobal(
    "Worker",
    class extends MockWorker {
      constructor() {
        super();
        MockWorker.created.push(this);
      }
    },
  );
}

function runResize(file: File, maxBytes = 6 * 1024 * 1024) {
  const controller = new AbortController();
  const processing: boolean[] = [];
  const promise = resizeChatAttachmentImage(file, maxBytes, controller.signal, (value) => {
    processing.push(value);
  });
  return { promise, processing };
}

describe("chat attachment JPEG preparation admission", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("admits only static PNG and JPEG uploads into resize preparation", () => {
    const png = new File([], "shot.png", { type: "image/png" });
    const jpeg = new File([], "photo.jpg", { type: "image/jpeg" });
    expect(canResizeChatAttachment(png)).toBe(true);
    expect(canResizeChatAttachment(jpeg)).toBe(true);
    for (const type of ["image/gif", "image/webp", "image/avif", "text/plain"]) {
      expect(canResizeChatAttachment(new File([], "file", { type }))).toBe(false);
    }
  });

  it("resizes a valid baseline JPEG through the preparation worker", async () => {
    stubWorker();
    const file = jpegFile(concat(SOI, EXIF_APP1, sof(4000, 3000), SOS, EOI));
    const { promise, processing } = runResize(file);
    await vi.waitFor(() => expect(MockWorker.created).toHaveLength(1));
    expect(processing).toEqual([false, true]);
    const prepared = jpegFile(concat(SOI, sof(1200, 900), SOS, EOI), "photo.jpg");
    MockWorker.created[0]!.complete(prepared);
    await expect(promise).resolves.toBe(prepared);
  });

  it("accepts a progressive JPEG frame header", async () => {
    stubWorker();
    const file = jpegFile(concat(SOI, sof(4000, 3000, 0xc2), SOS, EOI));
    const { promise } = runResize(file);
    await vi.waitFor(() => expect(MockWorker.created).toHaveLength(1));
    MockWorker.created[0]!.complete(file);
    await expect(promise).resolves.toBe(file);
  });

  it.each([
    ["missing SOI", concat(bytes(0x00, 0x00), sof(4000, 3000), SOS, EOI)],
    ["scan before any frame header", concat(SOI, SOS, EOI)],
    ["no frame header before end of image", concat(SOI, EXIF_APP1, EOI)],
    [
      "multi-picture JPEG",
      concat(
        SOI,
        segment(0xe2, bytes(0x4d, 0x50, 0x46, 0x00, 0x01, 0x02)),
        sof(4000, 3000),
        SOS,
        EOI,
      ),
    ],
  ])("rejects %s without starting a worker", async (_name, data) => {
    stubWorker();
    const { promise } = runResize(jpegFile(data));
    await expect(promise).rejects.toThrow();
    expect(MockWorker.created).toHaveLength(0);
  });

  it("rejects dimensions beyond the 25 MP decode budget", async () => {
    stubWorker();
    const { promise } = runResize(jpegFile(concat(SOI, sof(8000, 4000), SOS, EOI)));
    await expect(promise).rejects.toThrow("exceed the resize budget");
    expect(MockWorker.created).toHaveLength(0);
  });
});
