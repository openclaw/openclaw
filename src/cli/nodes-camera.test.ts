import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cameraTempPath,
  parseCameraClipPayload,
  parseCameraSnapPayload,
  writeBase64ToFile,
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

  it("writes camera clip payload to temp path", async () => {
    await withCameraTempDir(async (dir) => {
      const out = await writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 200,
          hasAudio: false,
        },
        facing: "front",
        tmpDir: dir,
        id: "clip1",
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-front-clip1.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  it("writes camera clip payload from url", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const expectedHost = "93.184.216.34";
      const out = await writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          url: `https://${expectedHost}/clip.mp4`,
          durationMs: 200,
          hasAudio: false,
        },
        facing: "back",
        tmpDir: dir,
        id: "clip2",
        expectedHost,
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-back-clip2.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-clip");
    });
  });

  it("rejects camera clip url payloads without node remoteIp", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await expect(
      writeCameraClipPayloadToFile({
        payload: {
          format: "mp4",
          url: "https://93.184.216.34/clip.mp4",
          durationMs: 200,
          hasAudio: false,
        },
        facing: "back",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });

  it("writes base64 to file", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeBase64ToFile(out, "aGk=");
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("hi");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes url payload to file", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await writeUrlToFile(out, "https://93.184.216.34/clip.mp4", {
        expectedHost: "93.184.216.34",
      });
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-content");
    });
  });

  it("rejects url host mismatches", async () => {
    stubFetchResponse(new Response("url-content", { status: 200 }));
    await expect(
      writeUrlToFile("/tmp/ignored", "https://93.184.216.34/clip.mp4", {
        expectedHost: "93.184.216.35",
      }),
    ).rejects.toThrow(/must match node host/i);
  });

  it("rejects invalid url payload responses", async () => {
    const cases: Array<{
      name: string;
      url: string;
      response?: Response;
      expectedMessage: RegExp;
    }> = [
      {
        name: "non-https url",
        url: "http://93.184.216.34/x.bin",
        expectedMessage: /only https/i,
      },
      {
        name: "oversized content-length",
        url: "https://93.184.216.34/huge.bin",
        response: new Response("tiny", {
          status: 200,
          headers: { "content-length": String(999_999_999) },
        }),
        expectedMessage: /exceeds max/i,
      },
      {
        name: "non-ok status",
        url: "https://93.184.216.34/down.bin",
        response: new Response("down", { status: 503, statusText: "Service Unavailable" }),
        expectedMessage: /503/i,
      },
      {
        name: "empty response body",
        url: "https://93.184.216.34/empty.bin",
        response: new Response(null, { status: 200 }),
        expectedMessage: /empty response body/i,
      },
    ];

    for (const testCase of cases) {
      if (testCase.response) {
        stubFetchResponse(testCase.response);
      }
      await expect(
        writeUrlToFile("/tmp/ignored", testCase.url, { expectedHost: "93.184.216.34" }),
        testCase.name,
      ).rejects.toThrow(testCase.expectedMessage);
    }
  });

  it("allows private IPs when they match the node's own expectedHost", async () => {
    stubFetchResponse(new Response("ok", { status: 200 }));
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "priv.bin");
      // A node on 192.168.1.100 should be able to serve its own camera feed
      await writeUrlToFile(out, "https://192.168.1.100/cam.jpg", {
        expectedHost: "192.168.1.100",
      });
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("ok");
    });
  });

  it("blocks SSRF to other private hosts via hostnameAllowlist", async () => {
    stubFetchResponse(new Response("should-not-reach", { status: 200 }));
    // Node is at 192.168.1.100, but URL points to a different private host
    await expect(
      writeUrlToFile("/tmp/ignored", "https://192.168.1.200/secret", {
        expectedHost: "192.168.1.100",
      }),
    ).rejects.toThrow(/must match node host/i);
  });

  it("rejects loopback and IPv6 addresses when they differ from expectedHost", async () => {
    stubFetchResponse(new Response("should-not-reach", { status: 200 }));
    for (const loopback of ["127.0.0.1", "[::1]"]) {
      await expect(
        writeUrlToFile("/tmp/ignored", `https://${loopback}/secret`, {
          expectedHost: "93.184.216.34",
        }),
        `should block ${loopback}`,
      ).rejects.toThrow(/must match node host/i);
    }
  });

  it("removes partially written file when url stream fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("stream exploded"));
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "broken.bin");
      await expect(
        writeUrlToFile(out, "https://93.184.216.34/broken.bin", { expectedHost: "93.184.216.34" }),
      ).rejects.toThrow(/stream exploded/i);
      await expect(fs.stat(out)).rejects.toThrow();
    });
  });
});

describe("nodes screen helpers", () => {
  it("parses screen.record payload", () => {
    const payload = parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: 1000,
      fps: 12,
      screenIndex: 0,
      hasAudio: true,
    });
    expect(payload.format).toBe("mp4");
    expect(payload.base64).toBe("Zm9v");
    expect(payload.durationMs).toBe(1000);
    expect(payload.fps).toBe(12);
    expect(payload.screenIndex).toBe(0);
    expect(payload.hasAudio).toBe(true);
  });

  it("drops invalid optional fields instead of throwing", () => {
    const payload = parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: "nope",
      fps: null,
      screenIndex: "0",
      hasAudio: 1,
    });
    expect(payload.durationMs).toBeUndefined();
    expect(payload.fps).toBeUndefined();
    expect(payload.screenIndex).toBeUndefined();
    expect(payload.hasAudio).toBeUndefined();
  });

  it("rejects invalid screen.record payload", () => {
    expect(() => parseScreenRecordPayload({ format: "mp4" })).toThrow(
      /invalid screen\.record payload/i,
    );
  });

  it("builds screen record temp path", () => {
    const p = screenRecordTempPath({
      ext: "mp4",
      tmpDir: "/tmp",
      id: "id1",
    });
    expect(p).toBe(path.join("/tmp", "openclaw-screen-record-id1.mp4"));
  });
});
