// Nodes camera tests cover camera node command media handling and file inputs.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchResponse,
} from "../test-utils/camera-url-test-helpers.js";
import { withTempDir } from "../test-utils/temp-dir.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;
type FsOpen = typeof import("node:fs/promises").open;

const fsMocks = vi.hoisted(() => ({
  actualOpen: undefined as FsOpen | undefined,
  open: vi.fn<FsOpen>(),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  fsMocks.actualOpen = actual.open;
  fsMocks.open.mockImplementation(actual.open);
  return { ...actual, open: fsMocks.open };
});

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: { url: string; timeoutMs?: number; requireHttps?: boolean }) => {
      return {
        response: await globalThis.fetch(params.url),
        finalUrl: params.url,
        release: async () => {},
      };
    },
  ),
}));

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  outputFileMocks.publishOutputFileAtomically.mockImplementation(
    actual.publishOutputFileAtomically,
  );
  return { ...actual, publishOutputFileAtomically: outputFileMocks.publishOutputFileAtomically };
});

let camera: typeof import("./nodes-camera.js");
let screen: typeof import("./nodes-screen.js");
let publishOutputFileAtomically: PublishOutputFileAtomically;

async function withCameraTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  return await withTempDir("openclaw-test-", run);
}

const cameraHost = "198.51.100.42";
const clipMetadata = { format: "mp4", durationMs: 200, hasAudio: false };
const snapPayload = { format: "jpg", width: 1, height: 1 };
const cameraUrl = (name: string) => `https://${cameraHost}/${name}`;
const writeUrl = (filePath: string, name: string) =>
  camera.writeCameraPayloadToFile({
    filePath,
    payload: { url: cameraUrl(name) },
    expectedHost: cameraHost,
  });

async function expectOutput(dir: string, out: string, content: string | Buffer) {
  await expect(fs.readFile(out)).resolves.toEqual(
    typeof content === "string" ? Buffer.from(content) : content,
  );
  if (process.platform !== "win32") {
    expect((await fs.stat(out)).mode & 0o777).toBe(0o640);
  }
  expect(await fs.readdir(dir)).toEqual([path.basename(out)]);
}

function cancelTrackedResponse(init?: ResponseInit) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("nodes camera helpers", () => {
  beforeAll(async () => {
    camera = await import("./nodes-camera.js");
    screen = await import("./nodes-screen.js");
    ({ publishOutputFileAtomically } = await vi.importActual("./output-file.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    if (!fsMocks.actualOpen) {
      throw new Error("expected actual fs.open implementation");
    }
    fsMocks.open.mockImplementation(fsMocks.actualOpen);
  });

  it("parses camera.snap payload", () => {
    expect(
      camera.parseCameraSnapPayload({ format: "jpg", base64: "aGk=", width: 10, height: 20 }),
    ).toEqual({ format: "jpg", base64: "aGk=", width: 10, height: 20 });
  });

  it("rejects invalid camera.snap payload", () => {
    expect(() => camera.parseCameraSnapPayload({ format: "jpg" })).toThrow(
      /invalid camera\.snap payload/i,
    );
  });

  it.each([
    [{ url: "http://198.51.100.42/photo.jpg" }, /only https/i],
    [{ url: "https://198.51.100.43/photo.jpg" }, /must match node host/i],
    [{ url: cameraUrl("photo.jpg"), base64: "not-base64!" }, /invalid base64/i],
  ] as const)("rejects invalid camera.snap URL payload %j", (payload, expectedError) => {
    expect(() =>
      camera.parseCameraSnapPayload({ ...snapPayload, ...payload }, { expectedHost: cameraHost }),
    ).toThrow(expectedError);
  });

  it("keeps Linux device selection facing-less", () => {
    expect(
      camera.resolveCameraSnapTargets({
        facing: "both",
        platform: "linux",
        deviceId: "/dev/video2",
      }),
    ).toEqual([{ artifactFacing: "unknown" }]);
  });

  it("uses one unknown target when facing is omitted on a positioned camera platform", () => {
    expect(camera.resolveCameraSnapTargets({ platform: "macos" })).toEqual([
      { artifactFacing: "unknown" },
    ]);
    expect(
      camera.resolveCameraSnapTargets({ platform: "macos", deviceId: "camera-device" }),
    ).toEqual([{ artifactFacing: "unknown" }]);
  });

  it("keeps explicit facing requests for positioned camera platforms", () => {
    expect(camera.resolveCameraSnapTargets({ facing: "front", platform: "macos" })).toEqual([
      { requestFacing: "front", artifactFacing: "front" },
    ]);
    expect(camera.resolveCameraSnapTargets({ facing: "back", platform: "macos" })).toEqual([
      { requestFacing: "back", artifactFacing: "back" },
    ]);
    expect(camera.resolveCameraSnapTargets({ facing: "both", platform: "macos" })).toEqual([
      { requestFacing: "front", artifactFacing: "front" },
      { requestFacing: "back", artifactFacing: "back" },
    ]);
    expect(() =>
      camera.resolveCameraSnapTargets({
        facing: "both",
        platform: "macos",
        deviceId: "camera-device",
      }),
    ).toThrow("facing=both is not allowed when deviceId is set");
  });

  it("labels Linux clips as unknown without sending unsupported facing", () => {
    expect(camera.resolveCameraClipTarget({ facing: "back", platform: "linux" })).toEqual({
      artifactFacing: "unknown",
    });
    expect(camera.resolveCameraClipTarget({ facing: "back", platform: "macos" })).toEqual({
      requestFacing: "back",
      artifactFacing: "back",
    });
  });

  it("parses camera.clip payload", () => {
    expect(
      camera.parseCameraClipPayload({
        format: "mp4",
        base64: "AAEC",
        durationMs: 1234,
        hasAudio: true,
      }),
    ).toEqual({ format: "mp4", base64: "AAEC", durationMs: 1234, hasAudio: true });
  });

  it("rejects invalid camera.clip payload", () => {
    expect(() =>
      camera.parseCameraClipPayload({ format: "mp4", base64: "AAEC", durationMs: 1234 }),
    ).toThrow(/invalid camera\.clip payload/i);
  });

  it("rejects media format path traversal", () => {
    expect(() =>
      camera.cameraTempPath({ kind: "snap", ext: "../escaped", tmpDir: "/tmp", id: "id1" }),
    ).toThrow(/invalid media format/i);
    expect(() =>
      screen.screenRecordTempPath({ ext: "mp4/../../escaped", tmpDir: "/tmp", id: "id1" }),
    ).toThrow(/invalid media format/i);
    expect(() =>
      screen.screenSnapshotTempPath({ ext: "png/../../escaped", tmpDir: "/tmp", id: "id1" }),
    ).toThrow(/invalid media format/i);
  });

  it("writes camera clip payload to temp path", async () => {
    await withCameraTempDir(async (dir) => {
      const out = await camera.writeCameraClipPayloadToFile({
        payload: { ...clipMetadata, base64: "aGk=" },
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
      const out = await camera.writeCameraClipPayloadToFile({
        payload: { ...clipMetadata, url: cameraUrl("clip.mp4") },
        facing: "back",
        tmpDir: dir,
        id: "clip2",
        expectedHost: cameraHost,
      });
      expect(out).toBe(path.join(dir, "openclaw-camera-clip-back-clip2.mp4"));
      await expect(readFileUtf8AndCleanup(out)).resolves.toBe("url-clip");
      expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({ requireHttps: true, timeoutMs: 15 * 60_000 }),
      );
    });
  });

  it("rejects camera clip url payloads without node remoteIp", async () => {
    stubFetchResponse(new Response("url-clip", { status: 200 }));
    await expect(
      camera.writeCameraClipPayloadToFile({
        payload: { ...clipMetadata, url: cameraUrl("clip.mp4") },
        facing: "back",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });

  it.each([false, true])(
    "preserves output mode and contents on decoded write failure=%s",
    async (fails) => {
      await withCameraTempDir(async (dir) => {
        const out = path.join(dir, "x.bin");
        await fs.writeFile(out, "existing-screen");
        await fs.chmod(out, 0o640);
        if (fails) {
          outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) =>
            publishOutputFileAtomically({
              ...params,
              writeTemp: async (tempPath) => {
                await params.writeTemp(tempPath);
                await fs.truncate(tempPath, 1);
                throw new Error("injected node media write failure");
              },
            }),
          );
          await expect(screen.writeScreenRecordToFile(out, "aGk=")).rejects.toThrow(
            "injected node media write failure",
          );
        } else {
          await camera.writeBase64ToFile(out, " aGk\n");
        }
        await expectOutput(dir, out, fails ? "existing-screen" : "hi");
      });
    },
  );

  it("rejects oversized base64 payloads before writing", async () => {
    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "x.bin");
      await expect(camera.writeBase64ToFile(out, "aGk=", { maxBytes: 1 })).rejects.toThrow(
        /exceeds max/i,
      );
      await expect(fs.stat(out)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fully publishes url chunks after a positive short write", async () => {
    const chunks = [Buffer.from("positive short "), Buffer.from("write")];
    const expected = Buffer.concat(chunks);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    stubFetchResponse(new Response(stream, { status: 200 }));

    await withCameraTempDir(async (dir) => {
      const out = path.join(dir, "short-write.bin");
      await fs.writeFile(out, "existing-camera");
      const stagingRoot = `${await fs.realpath(dir)}${path.sep}`;
      const originalOpen = fsMocks.actualOpen;
      if (!originalOpen) {
        throw new Error("expected actual fs.open implementation");
      }
      let shortWriteObserved = false;
      fsMocks.open.mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        if (typeof args[0] !== "string" || !args[0].startsWith(stagingRoot) || args[1] !== "wx") {
          return handle;
        }

        let injectShortWrite = true;
        const injectedHandle = Object.create(handle) as typeof handle;
        injectedHandle.close = handle.close.bind(handle);
        injectedHandle.write = (async (
          buffer: Uint8Array,
          offset = 0,
          length = buffer.byteLength - offset,
        ) => {
          const writeLength = injectShortWrite ? Math.max(1, Math.floor(length / 2)) : length;
          injectShortWrite = false;
          shortWriteObserved ||= writeLength < length;
          return await handle.write(buffer, offset, writeLength);
        }) as typeof handle.write;
        injectedHandle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
          const buffer =
            typeof data === "string"
              ? Buffer.from(data)
              : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          let offset = 0;
          while (offset < buffer.byteLength) {
            const { bytesWritten } = await injectedHandle.write(
              buffer,
              offset,
              buffer.byteLength - offset,
            );
            offset += bytesWritten;
          }
        }) as typeof handle.writeFile;
        return injectedHandle;
      });

      await writeUrl(out, "short-write.bin");

      expect(shortWriteObserved).toBe(true);
      await expect(fs.readFile(out)).resolves.toEqual(expected);
      await expect(fs.stat(out)).resolves.toMatchObject({ size: expected.byteLength });
      expect(await fs.readdir(dir)).toEqual(["short-write.bin"]);
    });
  });

  it("rejects an empty URL response body", async () => {
    stubFetchResponse(new Response(null, { status: 200 }));
    await expect(writeUrl("/tmp/ignored", "empty.bin")).rejects.toThrow(/empty response body/i);
  });

  it.each([
    [{ status: 503, statusText: "Service Unavailable" }, /503/i],
    [{ status: 200, headers: { "content-length": String(999_999_999) } }, /exceeds max/i],
    [{ status: 200, headers: { "content-length": "0x3" } }, /invalid content-length/i],
  ] as const)("cancels rejected url response body: %j", async (init, expectedMessage) => {
    const tracked = cancelTrackedResponse(init);
    stubFetchResponse(tracked.response);

    await expect(writeUrl("/tmp/ignored", "down.bin")).rejects.toThrow(expectedMessage);
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("cancels response bodies when a redirect changes host", async () => {
    const tracked = cancelTrackedResponse({ status: 200 });
    fetchGuardMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: tracked.response,
      finalUrl: "https://198.51.100.43/clip.mp4",
      release: async () => {},
    });

    await expect(writeUrl("/tmp/ignored", "clip.mp4")).rejects.toThrow(/redirect host/i);
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each([
    ["broken.bin", new Error("stream exploded"), /stream exploded/i],
    ["empty.bin", undefined, /empty download/i],
  ] as const)(
    "preserves existing output when URL stream %s fails",
    async (name, error, message) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (error) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(error);
          } else {
            controller.close();
          }
        },
      });
      stubFetchResponse(new Response(stream, { status: 200 }));
      await withCameraTempDir(async (dir) => {
        const out = path.join(dir, name);
        const sentinel = Buffer.from("existing-camera");
        await fs.writeFile(out, sentinel);
        await fs.chmod(out, 0o640);
        await expect(writeUrl(out, name)).rejects.toThrow(message);
        await expectOutput(dir, out, sentinel);
      });
    },
  );
});

describe("nodes screen helpers", () => {
  it("parses screen.record payload", () => {
    const payload = screen.parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: 1000,
      fps: 12,
      screenIndex: 0,
      hasAudio: true,
    });
    expect(payload).toEqual({
      format: "mp4",
      base64: "Zm9v",
      durationMs: 1000,
      fps: 12,
      screenIndex: 0,
      hasAudio: true,
    });
  });

  it("drops invalid optional fields instead of throwing", () => {
    const payload = screen.parseScreenRecordPayload({
      format: "mp4",
      base64: "Zm9v",
      durationMs: "nope",
      fps: null,
      screenIndex: "0",
      hasAudio: 1,
    });
    expect(payload).toMatchObject({
      durationMs: undefined,
      fps: undefined,
      screenIndex: undefined,
      hasAudio: undefined,
    });
  });

  it("rejects invalid screen.record payload", () => {
    expect(() => screen.parseScreenRecordPayload({ format: "mp4" })).toThrow(
      /invalid screen\.record payload/i,
    );
  });

  it("maps a snapshot output path to the encoding the node should produce", () => {
    const suffixes = ["png", "PNG", "jpg", "jpeg", "", "webp"];
    expect(
      suffixes.map((ext) =>
        screen.screenSnapshotFormatForPath(`/workspace/shot${ext ? "." + ext : ""}`),
      ),
    ).toEqual(["png", "png", "jpeg", "jpeg", undefined, undefined]);
  });

  it("builds screen snapshot temp path from the reported format", () => {
    expect(screen.screenSnapshotTempPath({ ext: "jpg", tmpDir: "/tmp", id: "id1" })).toBe(
      path.join("/tmp", "openclaw-screen-snapshot-id1.jpg"),
    );
    expect(screen.screenSnapshotTempPath({ ext: "png", tmpDir: "/tmp", id: "id1" })).toBe(
      path.join("/tmp", "openclaw-screen-snapshot-id1.png"),
    );
  });
});
