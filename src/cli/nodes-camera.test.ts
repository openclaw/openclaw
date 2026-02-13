import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
  writeUrlToFile,
} from "./nodes-camera.js";

describe("nodes camera helpers", () => {
  it("parses camera.snap payload", () => {
    expect(
      parseCameraSnapPayload({
        format: "jpg",
        base64: "aGk=",
        width: 10,
        height: 20,
      }),
    ).toEqual({ format: "jpg", base64: "aGk=", width: 10, height: 20 });
  });

  it("rejects invalid camera.snap payload", () => {
    expect(() => parseCameraSnapPayload({ format: "jpg" })).toThrow(
      /invalid camera\.snap payload/i,
    );
  });

  it("parses camera.clip payload", () => {
    expect(
      parseCameraClipPayload({
        format: "mp4",
        base64: "AAEC",
        durationMs: 1234,
        hasAudio: true,
      }),
    ).toEqual({
      format: "mp4",
      base64: "AAEC",
      durationMs: 1234,
      hasAudio: true,
    });
  });

  it("builds stable temp paths when id provided", () => {
    const p = cameraTempPath({
      kind: "snap",
      facing: "front",
      ext: "jpg",
      tmpDir: "/tmp",
      id: "id1",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-camera-snap-front-id1.jpg"));
  });

  it("writes base64 to file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    const out = path.join(dir, "x.bin");
    await writeBase64ToFile(out, "aGk=");
    await expect(fs.readFile(out, "utf8")).resolves.toBe("hi");
    await fs.rm(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes url payload to file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("url-content", { status: 200 })),
    );
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    const out = path.join(dir, "x.bin");
    try {
      await writeUrlToFile(out, "https://example.com/clip.mp4");
      await expect(fs.readFile(out, "utf8")).resolves.toBe("url-content");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-https url payload", async () => {
    await expect(writeUrlToFile("/tmp/ignored", "http://example.com/x.bin")).rejects.toThrow(
      /only https/i,
    );
  });

  it("rejects oversized content-length for url payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("tiny", {
            status: 200,
            headers: { "content-length": String(999_999_999) },
          }),
      ),
    );
    await expect(writeUrlToFile("/tmp/ignored", "https://example.com/huge.bin")).rejects.toThrow(
      /exceeds max/i,
    );
  });
});
