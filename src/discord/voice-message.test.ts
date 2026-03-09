import type { ChildProcess, ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

type ExecCall = {
  command: string;
  args: string[];
  options?: ExecFileOptions;
};

type MockExecResult = {
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
};

const execCalls: ExecCall[] = [];
const mockExecResults: MockExecResult[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileImpl = (
    file: string,
    args?: readonly string[] | null,
    optionsOrCallback?: ExecFileOptions | ExecCallback | null,
    callbackMaybe?: ExecCallback,
  ) => {
    const normalizedArgs = Array.isArray(args) ? [...args] : [];
    const callback =
      typeof optionsOrCallback === "function" ? optionsOrCallback : (callbackMaybe ?? undefined);
    const options =
      typeof optionsOrCallback === "function" ? undefined : (optionsOrCallback ?? undefined);

    execCalls.push({
      command: file,
      args: normalizedArgs,
      options,
    });

    const next = mockExecResults.shift() ?? { stdout: "", stderr: "" };
    queueMicrotask(() => {
      callback?.(next.error ?? null, next.stdout ?? "", next.stderr ?? "");
    });
    return {} as ChildProcess;
  };
  const execFileWithCustomPromisify = execFileImpl as unknown as typeof actual.execFile & {
    [promisify.custom]?: (
      file: string,
      args?: readonly string[] | null,
      options?: ExecFileOptions | null,
    ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
  };
  execFileWithCustomPromisify[promisify.custom] = (
    file: string,
    args?: readonly string[] | null,
    options?: ExecFileOptions | null,
  ) =>
    new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolve, reject) => {
      execFileImpl(file, args, options, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return {
    ...actual,
    execFile: execFileWithCustomPromisify,
  };
});

vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp",
}));

const { ensureOggOpus } = await import("./voice-message.js");

describe("ensureOggOpus", () => {
  beforeEach(() => {
    execCalls.length = 0;
    mockExecResults.length = 0;
  });

  afterEach(() => {
    execCalls.length = 0;
    mockExecResults.length = 0;
  });

  it("rejects URL/protocol input paths", async () => {
    await expect(ensureOggOpus("https://example.com/audio.ogg")).rejects.toThrow(
      /local file path/i,
    );
    expect(execCalls).toHaveLength(0);
  });

  it("keeps .ogg only when codec is opus and sample rate is 48kHz", async () => {
    mockExecResults.push({ stdout: "opus,48000\n" });

    const result = await ensureOggOpus("/tmp/input.ogg");

    expect(result).toEqual({ path: "/tmp/input.ogg", cleanup: false });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].command).toBe("ffprobe");
    expect(execCalls[0].args).toContain("stream=codec_name,sample_rate");
    expect(execCalls[0].options?.timeout).toBe(10_000);
  });

  it("re-encodes .ogg opus when sample rate is not 48kHz", async () => {
    mockExecResults.push({ stdout: "opus,24000\n" });
    mockExecResults.push({ stdout: "" });

    const result = await ensureOggOpus("/tmp/input.ogg");
    const ffmpegCall = execCalls.find((call) => call.command === "ffmpeg");

    expect(result.cleanup).toBe(true);
    expect(result.path).toMatch(/^\/tmp\/voice-.*\.ogg$/);
    expect(ffmpegCall).toBeDefined();
    expect(ffmpegCall?.args).toContain("-t");
    expect(ffmpegCall?.args).toContain("1200");
    expect(ffmpegCall?.args).toContain("-ar");
    expect(ffmpegCall?.args).toContain("48000");
    expect(ffmpegCall?.options?.timeout).toBe(45_000);
  });

  it("re-encodes non-ogg input with bounded ffmpeg execution", async () => {
    mockExecResults.push({ stdout: "" });

    const result = await ensureOggOpus("/tmp/input.mp3");
    const ffprobeCalls = execCalls.filter((call) => call.command === "ffprobe");
    const ffmpegCalls = execCalls.filter((call) => call.command === "ffmpeg");

    expect(result.cleanup).toBe(true);
    expect(ffprobeCalls).toHaveLength(0);
    expect(ffmpegCalls).toHaveLength(1);
    expect(ffmpegCalls[0].options?.timeout).toBe(45_000);
    expect(ffmpegCalls[0].args).toEqual(expect.arrayContaining(["-vn", "-sn", "-dn"]));
  });
});
