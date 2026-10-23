import { afterAll, afterEach, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const queryWindowsRegistryValueMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));
vi.mock("./windows-install-roots.js", async (original) => ({
  ...(await original<typeof import("./windows-install-roots.js")>()),
  queryWindowsRegistryValue: queryWindowsRegistryValueMock,
}));

import {
  createWindowsOutputDecoder,
  decodeWindowsOutputBuffer,
  decodeWindowsTextFileBuffer,
} from "./windows-encoding.js";

const UTF16_OUTPUT_CASES = [
  Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x0a, 0x00]),
  Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a]),
] as const;

async function freshEncoding(platform: NodeJS.Platform, codePage: string | null = null) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  queryWindowsRegistryValueMock.mockReturnValue(codePage);
  vi.resetModules();
  return await import("./windows-encoding.js");
}

const windowsDecoder = (options: Parameters<typeof createWindowsOutputDecoder>[0] = {}) =>
  createWindowsOutputDecoder({ platform: "win32", windowsEncoding: "gbk", ...options });

afterAll(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  queryWindowsRegistryValueMock.mockReset();
});

it.each([
  ["win32", "857", "cp857", 857],
  ["win32", "864", null, 864],
  ["linux", null, null, null],
] as const)("caches OEM encoding on %s with code page %s", async (platform, raw, label, page) => {
  const e = await freshEncoding(platform, raw);
  expect([
    e.resolveWindowsOemEncoding(),
    e.resolveWindowsOemCodePage(),
    e.resolveWindowsOemEncoding(),
  ]).toEqual([label, page, label]);
  expect(queryWindowsRegistryValueMock).toHaveBeenCalledTimes(platform === "win32" ? 1 : 0);
  if (label) {
    expect([
      e.resolveWindowsOemCodePageForEncoding(label),
      e.resolveWindowsOemCodePageForEncoding("bogus"),
    ]).toEqual([857, null]);
    expect(queryWindowsRegistryValueMock).toHaveBeenCalledWith(
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      "OEMCP",
    );
  }
});

it("bounds and caches failed encoding probes", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  spawnSyncMock.mockReturnValue({
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    stderr: "",
    stdout: "",
  });
  vi.resetModules();
  const {
    decodeWindowsOutputBuffer: decodeOutputWithFreshCache,
    decodeWindowsTextFileBuffer: decodeTextWithFreshCache,
  } = await import("./windows-encoding.js");
  const undecodableByte = Buffer.from([0x80]);
  for (const decode of [decodeOutputWithFreshCache, decodeTextWithFreshCache]) {
    for (let call = 0; call < 2; call++) {
      expect(decode({ buffer: undecodableByte, platform: "win32" })).toBe(
        undecodableByte.toString("utf8"),
      );
    }
  }
  expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  const probeOptions = {
    env: expect.any(Object),
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  };
  expect(spawnSyncMock).toHaveBeenNthCalledWith(
    1,
    expect.any(String),
    ["/d", "/s", "/c", "chcp"],
    probeOptions,
  );
  expect(spawnSyncMock).toHaveBeenNthCalledWith(
    2,
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Text.Encoding]::Default.CodePage"],
    probeOptions,
  );
});

it.each([
  ["UTF-8 output", decodeWindowsOutputBuffer, Buffer.from("测试"), "测试"],
  ["legacy text files", decodeWindowsTextFileBuffer, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), "你好"],
] as const)("decodes %s with a legacy Windows code page", (_name, decode, buffer, expected) => {
  expect(decode({ buffer, platform: "win32", windowsEncoding: "gbk" })).toBe(expected);
});

it("replays split GBK bytes on UTF-8 fallback", () => {
  const decoder = windowsDecoder();
  expect([
    decoder.decode(Buffer.from([0xc4])),
    decoder.decode(Buffer.from([0xe3])),
    decoder.flush(),
  ]).toEqual(["", "你", ""]);
});

it("honors UTF-16 BOMs before UTF-8 fallback", () => {
  for (const raw of UTF16_OUTPUT_CASES) {
    for (const decode of [decodeWindowsOutputBuffer, decodeWindowsTextFileBuffer]) {
      expect(decode({ buffer: raw, platform: "win32", windowsEncoding: "utf-8" })).toBe("hi\n");
    }
  }
});

it("decodes UTF-16 BOM file buffers on linux", () => {
  for (const raw of UTF16_OUTPUT_CASES) {
    expect(decodeWindowsTextFileBuffer({ buffer: raw, platform: "linux" })).toBe("hi\n");
  }
});

it("decodes UTF-16BE output across every chunk boundary", () => {
  const raw = UTF16_OUTPUT_CASES[1];
  for (let split = 1; split < raw.length; split += 1) {
    const decoder = windowsDecoder();
    expect(
      decoder.decode(raw.subarray(0, split)) +
        decoder.decode(raw.subarray(split)) +
        decoder.flush(),
      `split ${split}`,
    ).toBe("hi\n");
  }
});

it("isolates empty-prefix and stream state", () => {
  const stdout = windowsDecoder();
  const stderr = windowsDecoder();
  const [stdoutRaw, stderrRaw] = UTF16_OUTPUT_CASES;
  expect([
    stdout.decode(Buffer.alloc(0)),
    stderr.decode(Buffer.alloc(0)),
    stdout.decode(stdoutRaw.subarray(0, 1)),
    stderr.decode(stderrRaw.subarray(0, 1)),
    stdout.decode(Buffer.alloc(0)),
    stderr.decode(Buffer.alloc(0)),
    stdout.decode(stdoutRaw.subarray(1)) + stdout.flush(),
    stderr.decode(stderrRaw.subarray(1)) + stderr.flush(),
  ]).toEqual(["", "", "", "", "", "", "hi\n", "hi\n"]);
});

it.each(["utf-8", "gbk"] as const)(
  "replays unmatched and lone BOM prefixes: %s",
  (windowsEncoding) => {
    for (const raw of [Buffer.from([0xff, 0x41]), Buffer.from([0xfe, 0x42])]) {
      const decoder = windowsDecoder({ windowsEncoding });
      expect(decoder.decode(raw.subarray(0, 1))).toBe("");
      expect(decoder.decode(raw.subarray(1)) + decoder.flush()).toBe(
        new TextDecoder(windowsEncoding).decode(raw),
      );
    }
    const lonePrefix = Buffer.from([0xff]);
    const decoder = createWindowsOutputDecoder({ platform: "win32", windowsEncoding });
    expect(decoder.decode(lonePrefix)).toBe("");
    expect(decoder.flush()).toBe(new TextDecoder(windowsEncoding).decode(lonePrefix));
  },
);

it.each([
  ["linux", "hello", [1, 2], ["", "", "\uFEFFhello", ""]],
  ["win32", "测试", [1, 2, 4], ["", "", "\uFEFF", "测试", ""]],
] as const)("preserves a split UTF-8 BOM on %s", (platform, text, splits, expected) => {
  const decoder = createWindowsOutputDecoder({
    platform,
    preserveUtf8Bom: true,
    windowsEncoding: "gbk",
  });
  const raw = Buffer.from(`\uFEFF${text}`);
  let start = 0;
  const decoded = [...splits, raw.length].map((end) => {
    const chunk = decoder.decode(raw.subarray(start, end));
    start = end;
    return chunk;
  });
  expect([...decoded, decoder.flush()]).toEqual(expected);
});
