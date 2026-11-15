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
  createWindowsTextFileDecoder,
  decodeWindowsOutputBuffer,
  decodeWindowsTextFileBuffer,
} from "./windows-encoding.js";

it("keeps a Windows file's prefix-selected encoding across later invalid bytes", () => {
  const prefix = Buffer.concat([
    Buffer.from("café\n"),
    Buffer.alloc(1024 * 1024 - 8, 0x20),
    Buffer.from([0xe2, 0x82]),
  ]);
  const decoder = createWindowsTextFileDecoder({
    prefix,
    complete: false,
    platform: "win32",
    windowsEncoding: "windows-1252",
  });
  expect(decoder.encoding).toBe("utf-8");
  expect(decoder.decode(prefix, { stream: true })).toMatch(/^café\n/);
  expect(decoder.decode(Buffer.from([0xac, 0xe9]))).toBe("€�");
  const legacy = createWindowsTextFileDecoder({
    prefix: Buffer.from([0xe9, 0x0a]),
    complete: false,
    platform: "win32",
    windowsEncoding: "windows-1252",
  });
  expect(legacy.decode(Buffer.from([0xe9, 0x0a, 0xe9]))).toBe("é\né");
});

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
const bytes = (...values: number[]) => Buffer.from(values);
function decodeChunks(decoder: ReturnType<typeof windowsDecoder>, chunks: Buffer[]) {
  return [...chunks.map((chunk) => decoder.decode(chunk)), decoder.flush()];
}

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
  }
});

it("bounds and caches failed encoding probes", async () => {
  spawnSyncMock.mockReturnValue({
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    stderr: "",
    stdout: "",
  });
  const fresh = await freshEncoding("win32");
  const undecodableByte = Buffer.from([0x80]);
  for (const decode of [fresh.decodeWindowsOutputBuffer, fresh.decodeWindowsTextFileBuffer]) {
    for (let call = 0; call < 2; call++) {
      expect(decode({ buffer: undecodableByte, platform: "win32" })).toBe(
        undecodableByte.toString("utf8"),
      );
    }
  }
  expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  for (const call of spawnSyncMock.mock.calls) {
    expect(call[2]).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL" });
  }
});

it.each([
  ["UTF-8 output", decodeWindowsOutputBuffer, Buffer.from("测试"), "测试"],
  ["legacy text files", decodeWindowsTextFileBuffer, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), "你好"],
] as const)("decodes %s with a legacy Windows code page", (_name, decode, buffer, expected) => {
  expect(decode({ buffer, platform: "win32", windowsEncoding: "gbk" })).toBe(expected);
});

it("replays split GBK bytes on UTF-8 fallback", () => {
  const decoder = windowsDecoder();
  expect(decodeChunks(decoder, [bytes(0xc4), bytes(0xe3)])).toEqual(["", "你", ""]);
});

it.each([
  ["win32", decodeWindowsOutputBuffer],
  ["win32", decodeWindowsTextFileBuffer],
  ["linux", decodeWindowsTextFileBuffer],
] as const)("honors UTF-16 BOMs in %s %s", (platform, decode) => {
  for (const raw of UTF16_OUTPUT_CASES) {
    expect(decode({ buffer: raw, platform, windowsEncoding: "utf-8" })).toBe("hi\n");
  }
});

it("decodes UTF-16BE output across every chunk boundary", () => {
  const raw = UTF16_OUTPUT_CASES[1];
  for (let split = 1; split < raw.length; split += 1) {
    const decoder = windowsDecoder();
    expect(
      decodeChunks(decoder, [raw.subarray(0, split), raw.subarray(split)]).join(""),
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
    for (const raw of [bytes(0xff, 0x41), bytes(0xfe, 0x42), bytes(0xff)]) {
      const decoder = windowsDecoder({ windowsEncoding });
      expect(decoder.decode(raw.subarray(0, 1))).toBe("");
      const rest = raw.length > 1 ? decoder.decode(raw.subarray(1)) : "";
      expect(rest + decoder.flush()).toBe(new TextDecoder(windowsEncoding).decode(raw));
    }
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
