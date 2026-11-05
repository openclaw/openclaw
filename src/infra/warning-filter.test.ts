import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function probe(source: string, env: NodeJS.ProcessEnv = {}, runtime = resolveTestNodeExecPath()) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.NODE_REDIRECT_WARNINGS;
  delete childEnv.NODE_NO_WARNINGS;
  const imports = runtime === process.execPath && process.versions.bun ? [] : ["./scripts/tsx.mjs"];
  const result = spawnSync(runtime, createNodeEvalArgs(source, { imports }), {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnv,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("warning filter", () => {
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

    probe(source, { OPENCLAW_WARNING_LOG: logFile });
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

  it("installs once and suppresses known warnings at emit time", () => {
    probe(
      `
      import assert from "node:assert/strict";
      import { setImmediate } from "node:timers/promises";
      import { installProcessWarningFilter } from "./src/infra/warning-filter.ts";
      const seenWarnings = [];
      process.on("warning", ({ code, name, message }) => seenWarnings.push({ code, name, message }));
      const makeWarning = (name, message, code) => ({ name, message, code });
      const punycode = makeWarning("DeprecationWarning", "The punycode module is deprecated.", "DEP0040");
      const warningError = (warning) => Object.assign(new Error(warning.message), warning);
      const extendMessage = "The \`util._extend\` API is deprecated. Please use Object.assign() instead.";
      installProcessWarningFilter();
      installProcessWarningFilter();
      installProcessWarningFilter();
      const emitWarning = (...args) => Reflect.apply(process.emitWarning, process, args);
      emitWarning(extendMessage, "DeprecationWarning", "DEP0060");
      emitWarning(extendMessage, { type: "DeprecationWarning", code: "DEP0060" });
      emitWarning(warningError(punycode));
      emitWarning(new Error("SQLite is an experimental feature and might change at any time"), {
        type: "ExperimentalWarning",
      });
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
      const byMessage = (a, b) => a.message.localeCompare(b.message);
      assert.deepEqual(seenWarnings.toSorted(byMessage), [visible, punycode, ...visibleWarnings].toSorted(byMessage));
    `,
      {},
      process.execPath,
    );
  });
});
