import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");
const baseEmitWarning = process.emitWarning.bind(process);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resetWarningFilterInstallState(): void {
  const globalState = globalThis as typeof globalThis & {
    [warningFilterKey]?: { installed: boolean };
  };
  delete globalState[warningFilterKey];
  process.emitWarning = baseEmitWarning;
}

describe("warning filter", () => {
  beforeEach(() => {
    resetWarningFilterInstallState();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    resetWarningFilterInstallState();
    vi.restoreAllMocks();
  });

  it("routes only Node's warning printer at WARN across repeated capture setup", () => {
    const tempDir = tempDirs.make("openclaw-warning-filter-");
    const logFile = path.join(tempDir, "warning.log");
    const marker = "OPENCLAW_WARNING_LEVEL_PROBE";
    const applicationMarker = "OPENCLAW_FORGED_WARNING_PREFIX_ERROR";
    const source = `
      process.on("warning", () => console.error("(" + process.release.name + ":" + process.pid + ") ${applicationMarker}"));
      const { installProcessWarningFilter } = await import("./src/infra/warning-filter.ts");
      const { enableConsoleCapture } = await import("./src/logging/console.ts");
      const { flushLogger, setLoggerOverride } = await import("./src/logging/logger.ts");
      setLoggerOverride({ level: "trace", file: process.env.OPENCLAW_WARNING_LOG, consoleLevel: "silent" });
      installProcessWarningFilter();
      enableConsoleCapture();
      enableConsoleCapture();
      process.emitWarning("${marker}", { code: "${marker}" });
      await new Promise((resolve) => setImmediate(resolve));
      await flushLogger();
    `;

    const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_WARNING_LOG: logFile };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.NODE_REDIRECT_WARNINGS;
    delete childEnv.NODE_NO_WARNINGS;
    const result = spawnSync(
      resolveTestNodeExecPath(),
      ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: childEnv,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const records = fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: string; _meta?: { logLevelName?: string } });
    expect(records.find((record) => record.message?.includes(marker))?._meta?.logLevelName).toBe(
      "WARN",
    );
    expect(
      records.find((record) => record.message?.endsWith(applicationMarker))?._meta?.logLevelName,
    ).toBe("ERROR");
  });

  it("installs once and suppresses known warnings at emit time", async () => {
    const seenWarnings: Array<{ code?: string; name: string; message: string }> = [];
    const onWarning = ({ code, name, message }: Error & { code?: string }) => {
      seenWarnings.push({ code, name, message });
    };
    const makeWarning = (name: string, message: string, code?: string) => ({ name, message, code });
    const punycode = makeWarning(
      "DeprecationWarning",
      "The punycode module is deprecated.",
      "DEP0040",
    );
    const warningError = (warning: { name: string; code?: string; message: string }) =>
      Object.assign(new Error(warning.message), warning);
    const extendMessage =
      "The `util._extend` API is deprecated. Please use Object.assign() instead.";

    process.on("warning", onWarning);
    try {
      installProcessWarningFilter();
      installProcessWarningFilter();
      installProcessWarningFilter();
      const emitWarning = (...args: unknown[]) =>
        (process.emitWarning as unknown as (...warningArgs: unknown[]) => void)(...args);

      emitWarning(extendMessage, "DeprecationWarning", "DEP0060");
      emitWarning(extendMessage, { type: "DeprecationWarning", code: "DEP0060" });
      emitWarning(warningError(punycode));
      emitWarning(new Error("SQLite is an experimental feature and might change at any time"), {
        type: "ExperimentalWarning",
      });
      await setImmediate();
      expect(seenWarnings).toEqual([]);

      const visible = makeWarning("Warning", "Visible warning", "OPENCLAW_TEST_WARNING");
      emitWarning(visible.message, { type: visible.name, code: visible.code });
      emitWarning(warningError(punycode), { type: "Warning", code: "OPENCLAW_VISIBLE_OVERRIDE" });
      const visibleWarnings = [
        makeWarning("DeprecationWarning", "Totally new warning", "DEP9999"),
        makeWarning("ExperimentalWarning", "Different experimental warning"),
        { ...punycode, message: "Different deprecated module" },
      ];
      for (const warning of visibleWarnings) {
        process.emitWarning(warningError(warning));
      }
      await setImmediate();
      for (const expected of [visible, punycode, ...visibleWarnings]) {
        expect(seenWarnings.find((seen) => seen.message === expected.message)).toStrictEqual(
          expected,
        );
      }
    } finally {
      process.off("warning", onWarning);
    }
  });
});
