// Covers Windows command-output code page parsing and decoding.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import {
  createWindowsOutputDecoder,
  decodeWindowsOutputBuffer,
  decodeWindowsTextFileBuffer,
} from "./windows-encoding.js";

describe("windows output encoding", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
  });

  it("bounds and caches failed Windows encoding probes", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    spawnSyncMock.mockReturnValue({
      error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
      output: [null, "", ""],
      pid: 1,
      signal: "SIGKILL",
      status: null,
      stderr: "",
      stdout: "",
    });
    vi.resetModules();
    const {
      decodeWindowsOutputBuffer: decodeOutputWithFreshCache,
      decodeWindowsTextFileBuffer: decodeTextWithFreshCache,
    } = await import("./windows-encoding.js");
    const undecodableByte = Buffer.from([0x80]);

    expect(decodeOutputWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeOutputWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeTextWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );
    expect(decodeTextWithFreshCache({ buffer: undecodableByte, platform: "win32" })).toBe(
      undecodableByte.toString("utf8"),
    );

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ["/d", "/s", "/c", "chcp"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        windowsHide: true,
      },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Text.Encoding]::Default.CodePage"],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        windowsHide: true,
      },
    );
  });

  it("decodes GBK output on Windows when UTF-8 is invalid and code page is known", () => {
    const raw = Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xa1, 0xab, 0xa3, 0xbb]);

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试～；");
  });

  it("prefers valid UTF-8 output on Windows even when the console code page is legacy", () => {
    const raw = Buffer.from("测试", "utf8");

    expect(
      decodeWindowsOutputBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("测试");
  });

  it("decodes legacy text files with the Windows system encoding", () => {
    const raw = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);

    expect(
      decodeWindowsTextFileBuffer({
        buffer: raw,
        platform: "win32",
        windowsEncoding: "gbk",
      }),
    ).toBe("你好");
  });

  it("supports common Windows system codepage decoder labels", () => {
    for (const encoding of [
      "windows-874",
      "windows-1250",
      "windows-1251",
      "windows-1252",
      "windows-1253",
      "windows-1254",
      "windows-1255",
      "windows-1256",
      "windows-1257",
      "windows-1258",
    ]) {
      expect(() => new TextDecoder(encoding)).not.toThrow();
    }
  });

  it("keeps multibyte Windows codepage characters intact across chunk boundaries", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xb2]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe2, 0xca]))).toBe("测");
    expect(decoder.decode(Buffer.from([0xd4]))).toBe("试");
    expect(decoder.flush()).toBe("");
  });

  it("replays buffered UTF-8 lead bytes when split GBK output falls back to the console code page", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });

    expect(decoder.decode(Buffer.from([0xc4]))).toBe("");
    expect(decoder.decode(Buffer.from([0xe3]))).toBe("你");
    expect(decoder.flush()).toBe("");
  });

  it("keeps split valid UTF-8 output on the UTF-8 path for streaming decode", () => {
    const decoder = createWindowsOutputDecoder({
      platform: "win32",
      windowsEncoding: "gbk",
    });
    const raw = Buffer.from("测试", "utf8");

    expect(decoder.decode(raw.subarray(0, 1))).toBe("");
    expect(decoder.decode(raw.subarray(1, 3))).toBe("测");
    expect(decoder.decode(raw.subarray(3))).toBe("试");
    expect(decoder.flush()).toBe("");
  });

  it("keeps split UTF-8 output intact on POSIX", () => {
    const decoder = createWindowsOutputDecoder({ platform: "linux" });
    const raw = Buffer.from(JSON.stringify({ text: "hello 世" }), "utf8");
    const splitIndex = raw.indexOf(
      expectDefined(Buffer.from("世", "utf8")[0], 'Buffer.from("世", "utf8")[0] test invariant'),
    );

    expect(decoder.decode(raw.subarray(0, splitIndex + 1))).toBe(
      raw.subarray(0, splitIndex).toString("utf8"),
    );
    expect(decoder.decode(raw.subarray(splitIndex + 1))).toBe('世"}');
    expect(decoder.flush()).toBe("");
  });
});
