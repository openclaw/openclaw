import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logContains } from "../../scripts/e2e/lib/onboard/log-contains.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/onboard/log-contains.mjs";

describe("onboard log-contains helper", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function writeLog(contents: string) {
    const root = tempDirs.make("openclaw-onboard-log-");
    const logPath = path.join(root, "wizard.log");
    writeFileSync(logPath, contents, "utf8");
    return logPath;
  }

  it.each([
    [
      "ANSI read boundary",
      `${"x".repeat(65_535)}\u001b[36mBoundary prompt\u001b[0m`,
      "boundary prompt",
    ],
    ["UTF-8 read boundary", `${"x".repeat(65_535)}Key prompt`, "key prompt"],
    ["lowercase expansion", "İnput prompt", "input prompt"],
    ["OSC escape followed by BEL", "\u001b]title\u001b\u0007Visible prompt", "visible prompt"],
  ])("finds visible text through %s", (_label, contents, needle) => {
    expect(logContains(writeLog(contents), needle)).toBe(true);
  });

  it("ignores Docker TTY line separators inside ANSI sequences", () => {
    const splitBytes = (value: string) => value.split("").join("\r\n");
    const prompt = "How should I set things up?";
    const decoratedPrompt = prompt
      .split("")
      .map((character) => `${splitBytes("\u001b[36m")}│${splitBytes("\u001b[39m")} ${character}`)
      .join("\r\n");
    const logPath = writeLog(decoratedPrompt);

    expect(logContains(logPath, prompt)).toBe(true);
  });

  it("scans the full log and preserves CLI status for matching and missing logs", () => {
    const logPath = writeLog(
      `Model/\u001b[36mauth\u001b[0m\n provider${"x".repeat(2 * 1_048_576)}\nWizard Complete\n`,
    );

    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "Model/auth provider"]).status).toBe(
      0,
    );
    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "wizard complete"]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, logPath, "prefix marker"]).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT_PATH, `${logPath}.missing`, "wizard"]).status).toBe(
      1,
    );
  });
});
