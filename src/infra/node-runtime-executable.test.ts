import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

it("selects a Windows Node executable and excludes unrelated probe environment", () => {
  mockBun();
  mockProcessPlatform("win32");
  probe.mockReturnValueOnce(String.raw`D:\NodeBin\node.exe` + "\r\n");

  expect(
    resolveNodeRuntimeExecutable({
      env: {
        PATH: String.raw`D:\NodeBin`,
        PATHEXT: ".EXE",
        SystemRoot: String.raw`D:\Windows`,
        QA_PARENT_ONLY: "synthetic",
      },
    }),
  ).toBe(String.raw`D:\NodeBin\node.exe`);
  expect(probe).toHaveBeenCalledWith(
    String.raw`D:\NodeBin\node.exe`,
    ["--eval", expect.any(String)],
    {
      encoding: "utf8",
      env: { SystemRoot: String.raw`D:\Windows` },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    },
  );
});

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
