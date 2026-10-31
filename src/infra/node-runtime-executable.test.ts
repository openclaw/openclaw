import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nodeRuntimePathEntries, stripNodeStartupHooks } from "../../node-runtime-env.mjs";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeRuntimeExecutable } from "./node-runtime-executable.js";

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: probe,
}));

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return {
    ...actual,
    default: {
      ...actual,
      get delimiter() {
        return process.platform === "win32" ? ";" : ":";
      },
      join: (...parts: string[]) =>
        (process.platform === "win32" ? actual.win32 : actual.posix).join(...parts),
    },
  };
});

it("strips startup hooks while preserving unrelated Node options", () => {
  expect(
    stripNodeStartupHooks(
      '--im"port" "file:///instrumentation hook.mjs" --loader ./loader.mjs --max-old-space-size=256 --no-warnings',
    ),
  ).toBe('"--max-old-space-size=256" "--no-warnings"');
  expect(stripNodeStartupHooks(undefined)).toBeUndefined();
  expect(stripNodeStartupHooks("--no-warnings")).toBe("--no-warnings");
  expect(() => stripNodeStartupHooks('"unterminated')).toThrow(
    "Invalid NODE_OPTIONS for process owner",
  );
});

beforeEach(() => probe.mockReset());
afterEach(() => {
  probe.mockReset();
  vi.restoreAllMocks();
});

function mockBun() {
  vi.spyOn(process, "versions", "get").mockReturnValue({
    ...process.versions,
    bun: "qa-fixture",
  });
}

it("reuses a current Node executable named nodejs without probing PATH", () => {
  vi.spyOn(process, "versions", "get").mockReturnValue({ ...process.versions, bun: undefined });
  vi.spyOn(process, "execPath", "get").mockReturnValue("/usr/bin/nodejs");

  expect(resolveNodeRuntimeExecutable()).toBe("/usr/bin/nodejs");
  expect(probe).not.toHaveBeenCalled();
});

it.each(['"', ""])(
  "selects a %s-quoted Windows Node and excludes unrelated probe environment",
  (quote) => {
    mockBun();
    mockProcessPlatform("win32");
    probe.mockImplementation((candidate) => {
      if (candidate !== String.raw`D:\Program Files\nodejs\node.exe`) {
        throw new Error("fixture executable unavailable");
      }
      return candidate + "\r\n";
    });

    expect(
      resolveNodeRuntimeExecutable({
        env: {
          PATH: `${quote}D:\\Program Files\\nodejs${quote};`,
          PATHEXT: ".EXE",
          SystemRoot: String.raw`D:\Windows`,
          QA_PARENT_ONLY: "synthetic",
        },
      }),
    ).toBe(String.raw`D:\Program Files\nodejs\node.exe`);
    expect(probe).toHaveBeenCalledWith(
      String.raw`D:\Program Files\nodejs\node.exe`,
      ["--eval", expect.any(String)],
      {
        encoding: "utf8",
        env: { SystemRoot: String.raw`D:\Windows` },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    );
  },
);

it("skips a Bun node shim before selecting a real Node executable", () => {
  mockBun();
  mockProcessPlatform("linux");
  probe.mockReturnValueOnce("").mockReturnValueOnce("/qa/node/node\n");

  expect(resolveNodeRuntimeExecutable({ env: { PATH: "/qa/shim:/qa/node" } })).toBe(
    "/qa/node/node",
  );
  expect(probe.mock.calls.map(([candidate]) => candidate)).toEqual([
    "/qa/shim/node",
    "/qa/node/node",
  ]);
});

it("reports an unavailable runtime when every Node candidate fails", () => {
  mockBun();
  mockProcessPlatform("linux");
  probe.mockImplementation(() => {
    throw new Error("fixture executable unavailable");
  });

  expect(resolveNodeRuntimeExecutable({ env: { PATH: "/qa/missing" } })).toBeUndefined();
});

it.each([
  { platform: "win32", value: undefined, entries: [] },
  { platform: "win32", value: ';"";;', entries: [] },
  {
    platform: "win32",
    value: '"C:\\Program Files\\nodejs";;D:\\bin;',
    entries: ["C:\\Program Files\\nodejs", "D:\\bin"],
  },
  {
    platform: "win32",
    value: 'C:\\a"b;"C:\\unmatched;C:\\end"',
    entries: ['C:\\a"b', '"C:\\unmatched', 'C:\\end"'],
  },
  {
    platform: "linux",
    value: ':"/quoted path":/plain;;path:',
    entries: ['"/quoted path"', "/plain;;path"],
  },
] as const)(
  "parses $platform PATH $value without interpreting embedded quotes",
  ({ platform, value, entries }) => {
    mockProcessPlatform(platform);
    expect(nodeRuntimePathEntries(value)).toEqual(entries);
  },
);
