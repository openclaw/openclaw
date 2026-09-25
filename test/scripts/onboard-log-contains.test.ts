// Onboard log contains tests cover bounded E2E wizard log polling.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logContains } from "../../scripts/e2e/lib/onboard/log-contains.mjs";

const SCRIPT_PATH = "scripts/e2e/lib/onboard/log-contains.mjs";

describe("onboard log-contains helper", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function writeLog(contents: string) {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-onboard-log-"));
    tempRoots.push(root);
    const logPath = path.join(root, "wizard.log");
    writeFileSync(logPath, contents, "utf8");
    return logPath;
  }

  it("retains an earlier prompt across a large terminal redraw", () => {
    const logPath = writeLog(
      `What should we call your first agent?\n${"\u001b[36m│\u001b[39m agent\r\n".repeat(12_000)}`,
    );

    expect(logContains(logPath, "What should we call your first agent?")).toBe(true);
  });

  it("finds a prompt before more than one terminal window of later output", () => {
    const logPath = writeLog(
      `Model/\u001b[36mauth\u001b[0m\n provider${"x".repeat(2 * 1_048_576)}`,
    );

    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "Model/auth provider"]).status).toBe(
      0,
    );
  });

  it("preserves ANSI parser state across read boundaries", () => {
    const logPath = writeLog(`${"x".repeat(65_535)}\u001b[36mBoundary prompt\u001b[0m`);

    expect(logContains(logPath, "boundary prompt")).toBe(true);
  });

  it("preserves decoded prompt text across read boundaries", () => {
    const logPath = writeLog(`${"x".repeat(65_535)}Key prompt`);

    expect(logContains(logPath, "key prompt")).toBe(true);
  });

  it("normalizes lowercase expansions like the original matcher", () => {
    const logPath = writeLog("İnput prompt");

    expect(logContains(logPath, "input prompt")).toBe(true);
  });

  it("ends an OSC sequence on BEL after an escape", () => {
    const logPath = writeLog("\u001b]title\u001b\u0007Visible prompt");

    expect(logContains(logPath, "visible prompt")).toBe(true);
  });

  it("preserves CLI status behavior for matching and missing logs", () => {
    const logPath = writeLog(`${"x".repeat(4096)}\nWizard Complete\n`);

    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "wizard complete"]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "prefix marker"]).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, `${logPath}.missing`, "wizard"]).status).toBe(
      1,
    );
  });
});
