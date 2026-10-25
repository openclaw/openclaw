import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { resolveNodeRuntimeExecutable } from "./node-runtime-executable.js";

// Platform fixtures do not create host files; the generated bootstrap has separate process proof.
vi.mock("../../runtime-process-scripts.generated.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime-process-scripts.generated.mjs")>()),
  createRuntimeProcessScriptFile: () => ({
    url: new URL("file:///qa/node-runtime-probe.mjs"),
    dispose() {},
  }),
}));

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
      [expect.stringMatching(/node-runtime-probe\.mjs$/), ""],
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
