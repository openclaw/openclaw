import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  runFfmpeg,
  runFfprobe,
} from "./ffmpeg-exec.js";

const { execFileMock, resolveSystemBinMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  resolveSystemBinMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../infra/resolve-system-bin.js", () => ({
  resolveSystemBin: resolveSystemBinMock,
}));

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

function createExecFileChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  return child;
}

function mockFfprobeExecFile(child: ChildProcess): {
  execCallback: () => ExecFileCallback;
} {
  let execCallback: ExecFileCallback | undefined;
  execFileMock.mockImplementationOnce(
    (_file: string, _args: string[], _options: ExecFileOptions, callback: ExecFileCallback) => {
      execCallback = callback;
      return child;
    },
  );
  return {
    execCallback: () => {
      if (!execCallback) {
        throw new Error("execFile callback was not captured");
      }
      return execCallback;
    },
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  resolveSystemBinMock.mockReset();
  resolveSystemBinMock.mockReturnValue("/usr/bin/ffprobe");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseFfprobeCsvFields", () => {
  function expectParsedFfprobeCsvCase(input: string, fieldCount: number, expected: string[]) {
    expect(parseFfprobeCsvFields(input, fieldCount)).toEqual(expected);
  }

  it.each([
    { input: "opus,\n48000\n", fieldCount: 2, expected: ["opus", "48000"] },
    { input: "opus,48000,stereo\n", fieldCount: 3, expected: ["opus", "48000", "stereo"] },
  ] as const)("splits ffprobe csv output %#", ({ input, fieldCount, expected }) => {
    expectParsedFfprobeCsvCase(input, fieldCount, [...expected]);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  function expectParsedCodecAndSampleRateCase(
    input: string,
    expected: { codec: string | null; sampleRateHz: number | null },
  ) {
    expect(parseFfprobeCodecAndSampleRate(input)).toEqual(expected);
  }

  it.each([
    {
      name: "normalizes codec casing and parses numeric sample rates",
      input: "Opus,48000\n",
      expected: {
        codec: "opus",
        sampleRateHz: 48_000,
      },
    },
    {
      name: "keeps codec when the sample rate is not numeric",
      input: "opus,not-a-number",
      expected: {
        codec: "opus",
        sampleRateHz: null,
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    expectParsedCodecAndSampleRateCase(input, expected);
  });
});

describe("runFfprobe", () => {
  it("passes a sanitized owned env to ffprobe without stdin", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-secret");
    vi.stubEnv("LANG", "en_US.UTF-8");
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _options: ExecFileOptions, callback: ExecFileCallback) => {
        callback(
          null,
          { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) } as unknown as Buffer,
          Buffer.alloc(0),
        );
        return createExecFileChild();
      },
    );

    await expect(runFfprobe(["-version"])).resolves.toBe("ok");

    const options = execFileMock.mock.calls[0]?.[2] as ExecFileOptions | undefined;
    expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(options?.env?.LANG).toBe("en_US.UTF-8");
  });

  it("handles stdin EPIPE without overriding successful ffprobe stdout", async () => {
    const child = createExecFileChild();
    const { execCallback } = mockFfprobeExecFile(child);

    const promise = runFfprobe(["pipe:0"], { input: Buffer.alloc(1024) });

    const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => child.stdin?.emit("error", stdinError)).not.toThrow();
    execCallback()(null, Buffer.from("ok"), Buffer.alloc(0));

    await expect(promise).resolves.toBe("ok");
  });

  it("preserves the child callback error after stdin EPIPE", async () => {
    const child = createExecFileChild();
    const { execCallback } = mockFfprobeExecFile(child);

    const promise = runFfprobe(["pipe:0"], { input: Buffer.alloc(1024) });

    const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => child.stdin?.emit("error", stdinError)).not.toThrow();
    const childError = new Error("ffprobe failed");
    execCallback()(childError, "", "");

    await expect(promise).rejects.toBe(childError);
  });
});

describe("runFfmpeg", () => {
  it("passes a sanitized owned env to ffmpeg", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-secret");
    vi.stubEnv("NODE_ENV", "test");
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _options: ExecFileOptions, callback: ExecFileCallback) => {
        callback(
          null,
          { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) } as unknown as Buffer,
          Buffer.alloc(0),
        );
        return createExecFileChild();
      },
    );

    await expect(runFfmpeg(["-version"])).resolves.toBe("ok");

    const options = execFileMock.mock.calls[0]?.[2] as ExecFileOptions | undefined;
    expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options?.env?.NODE_ENV).toBe("test");
  });
});
