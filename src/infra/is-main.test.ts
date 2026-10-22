import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMainModule } from "./is-main.js";

const detect = (overrides: Partial<Parameters<typeof isMainModule>[0]> = {}) =>
  isMainModule({
    currentFile: "/repo/dist/index.js",
    argv: ["node", "/repo/openclaw.mjs"],
    env: {},
    ...overrides,
  });
const wrapperEntryPairs = [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }];

describe("isMainModule", () => {
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue("/repo");
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns true when argv[1] matches current file", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/repo/dist/index.js"],
        env: {},
      }),
    ).toBe(true);
  });

  it("falls back to the current file directory when process.cwd is unavailable", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    });
    try {
      expect(
        detect({
          argv: ["node", "/repo/dist/index.js"],
        }),
      ).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("resolves relative pm_exec_path values against cwd", () => {
    expect(
      detect({
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        env: { pm_exec_path: "./dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it.each<[string, typeof wrapperEntryPairs, boolean]>([
    ["/repo/dist/entry.js", wrapperEntryPairs, true],
    ["/repo/dist/entry.js", [], false],
    ["/repo/dist/index.js", wrapperEntryPairs, false],
  ])("matches only configured wrapper-to-entry pairs (%s, %j)", (currentFile, pairs, expected) => {
    expect(detect({ currentFile, wrapperEntryPairs: pairs })).toBe(expected);
  });

  it("returns false when this module is only imported under PM2", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        argv: ["node", "/repo/app.js"],
        env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
      }),
    ).toBe(false);
  });

  it("returns false for another entrypoint with the same basename", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        argv: ["node", "/repo/dist/index.js"],
        env: {},
      }),
    ).toBe(false);
  });

  it("returns false when no entrypoint candidate exists", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node"],
        env: {},
      }),
    ).toBe(false);
  });
});
