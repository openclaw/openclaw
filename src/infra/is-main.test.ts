import { describe, expect, it } from "vitest";
import { isMainModule } from "./is-main.js";

describe("isMainModule", () => {
  it("returns true when argv[1] matches current file", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/repo/dist/index.js"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(true);
  });

  it("returns true under PM2 when pm_exec_path matches current file", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        cwd: "/repo",
        env: { pm_exec_path: "/repo/dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("resolves relative pm_exec_path values against cwd", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        cwd: "/repo",
        env: { pm_exec_path: "./dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("returns true for configured wrapper-to-entry pairs", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/entry.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }],
      }),
    ).toBe(true);
  });

  it("returns false for unmatched wrapper launches", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/entry.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }],
      }),
    ).toBe(false);
  });

  it("returns false when this module is only imported under PM2", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        argv: ["node", "/repo/app.js"],
        cwd: "/repo",
        env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
      }),
    ).toBe(false);
  });

  it("falls back to basename matching for relative or symlinked entrypoints", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "../other/index.js"],
        cwd: "/repo/dist",
        env: {},
      }),
    ).toBe(true);
  });

  it("returns false when no entrypoint candidate exists", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
  });
});
