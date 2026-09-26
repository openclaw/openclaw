import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  takeNativeInferenceStartup,
  WORKER_NATIVE_INFERENCE_STARTUP_ENV,
  WORKER_NATIVE_INFERENCE_STARTUP_FD,
  WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES,
} from "./native-inference-startup.js";

const io = vi.hoisted(() => ({
  read: vi.fn<
    (fd: number, data: Buffer, offset: number, length: number, position: null) => number
  >(),
  close: vi.fn<(fd: number) => void>(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readSync: io.read,
  closeSync: io.close,
}));
afterEach(() => vi.resetAllMocks());

const startup = {
  config: {
    models: [
      {
        provider: "provider-1",
        id: "model-1",
        api: "openai-completions",
        baseUrl: "https://model.example.test/v1",
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        apiKeyEnv: "NATIVE_TEST_KEY",
      },
    ],
    workspaces: [
      { id: "agent-1", path: path.resolve("synthetic-workspace"), models: ["provider-1/model-1"] },
    ],
  },
  credentials: { NATIVE_TEST_KEY: "synthetic-opaque/Case+lease=v1.%25" },
};

function supply(bytes: Buffer, chunkBytes = bytes.length) {
  let position = 0;
  io.read.mockImplementation((_fd, data, offset, length) => {
    const count = Math.min(length, chunkBytes, bytes.length - position);
    data.set(bytes.subarray(position, position + count), offset);
    position += count;
    return count;
  });
}

function carrier() {
  return { [WORKER_NATIVE_INFERENCE_STARTUP_ENV]: String(WORKER_NATIVE_INFERENCE_STARTUP_FD) };
}

describe("private native inference startup input", () => {
  it("consumes fragmented input once and closes it before returning credentials", () => {
    supply(Buffer.from(JSON.stringify(startup)), 7);
    const env = carrier();
    expect(takeNativeInferenceStartup(env)).toEqual(startup);
    expect(env).not.toHaveProperty(WORKER_NATIVE_INFERENCE_STARTUP_ENV);
    expect(io.close).toHaveBeenCalledExactlyOnceWith(WORKER_NATIVE_INFERENCE_STARTUP_FD);
    const reads = io.read.mock.calls.length;
    expect(takeNativeInferenceStartup(env)).toBeUndefined();
    expect(io.read).toHaveBeenCalledTimes(reads);
  });

  it("does not read descriptors without a marker or accept JSON-in-environment fallback", () => {
    expect(takeNativeInferenceStartup({})).toBeUndefined();
    for (const value of ["", "0", "1", "2", "4", "03", "3.0", JSON.stringify(startup)]) {
      const env = { [WORKER_NATIVE_INFERENCE_STARTUP_ENV]: value };
      expect(() => takeNativeInferenceStartup(env)).toThrow(
        "Invalid node-local inference startup configuration",
      );
      expect(env).not.toHaveProperty(WORKER_NATIVE_INFERENCE_STARTUP_ENV);
    }
    expect(io.read).not.toHaveBeenCalled();
    expect(io.close).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty", bytes: Buffer.alloc(0) },
    { name: "malformed", bytes: Buffer.from("synthetic-private-invalid-json") },
    { name: "invalid shape", bytes: Buffer.from("{}") },
    { name: "oversized", bytes: Buffer.alloc(WORKER_NATIVE_INFERENCE_STARTUP_MAX_BYTES + 1, 32) },
  ])("closes and redacts $name startup input", ({ bytes }) => {
    supply(bytes);
    const env = carrier();
    expect(() => takeNativeInferenceStartup(env)).toThrow(
      /^Invalid node-local inference startup configuration$/,
    );
    expect(env).not.toHaveProperty(WORKER_NATIVE_INFERENCE_STARTUP_ENV);
    expect(io.close).toHaveBeenCalledExactlyOnceWith(WORKER_NATIVE_INFERENCE_STARTUP_FD);
  });
});
