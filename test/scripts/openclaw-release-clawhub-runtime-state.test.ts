// OpenClaw release ClawHub runtime-state script tests cover its CLI-only parser.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const SCRIPT_PATH = resolve("scripts/openclaw-release-clawhub-runtime-state.ts");
const TSX_LOADER = import.meta.resolve("tsx");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runRuntimeStateScript(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("scripts/openclaw-release-clawhub-runtime-state.ts", () => {
  it.each(["repository", "outside repository"])(
    "emits awaited-run proof from %s without build artifacts",
    (location) => {
      const cwd =
        location === "repository" ? process.cwd() : tempDirs.make("clawhub-runtime-state-");
      const result = runRuntimeStateScript(
        [
          "--repository",
          "openclaw/openclaw",
          "--wait-for-clawhub",
          "true",
          "--force-skip-clawhub",
          "false",
          "--normal-run-id",
          "123",
          "--bootstrap-run-id",
          "456",
          "--bootstrap-completed",
          "true",
        ],
        cwd,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        verifierArgs: ["--plugin-clawhub-run", "123", "--plugin-clawhub-bootstrap-run", "456"],
        proofLines: {
          normal: "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/123",
          bootstrap:
            "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/456",
        },
      });
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    { staged: true, failed: false },
    { staged: true, failed: true },
    { staged: false, failed: true },
  ])(
    "keeps parent publication proof consistent (staged=$staged, failed=$failed)",
    ({ staged, failed }) => {
      const result = runRuntimeStateScript([
        "--repository",
        "openclaw/openclaw",
        "--wait-for-clawhub",
        "true",
        "--force-skip-clawhub",
        String(failed),
        "--normal-publication-staged",
        String(staged),
        "--normal-run-id",
        "123",
        "--bootstrap-run-id",
        "456",
        "--bootstrap-completed",
        "true",
      ]);
      expect(result.status).toBe(0);
      const state = JSON.parse(result.stdout);
      expect(state.verifierArgs).toEqual(
        failed
          ? ["--skip-clawhub"]
          : [
              "--skip-clawhub",
              "--plugin-clawhub-run",
              "123",
              "--plugin-clawhub-bootstrap-run",
              "456",
            ],
      );
      if (failed) {
        expect(state.proofLines.normal).toContain("not verified after a required ClawHub failure");
        expect(state.proofLines.bootstrap).toContain(
          "not verified after a required ClawHub failure",
        );
        expect(state.proofLines.normal).not.toContain("ClawHub submission");
      } else {
        expect(state.proofLines.normal).toContain(
          "public finalization and exact artifact verification follow terminal release-parent completion",
        );
      }
      expect(state.proofLines.normal).toContain("actions/runs/123");
      expect(state.proofLines.bootstrap).toContain("actions/runs/456");
    },
  );

  it("rejects invalid boolean flag values before emitting runtime state", () => {
    const result = runRuntimeStateScript([
      "--repository",
      "openclaw/openclaw",
      "--wait-for-clawhub",
      "yes",
      "--force-skip-clawhub",
      "false",
      "--bootstrap-completed",
      "false",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--wait-for-clawhub must be true or false.");
    expect(result.stdout).toBe("");
  });

  it("requires the workflow repository argument", () => {
    const result = runRuntimeStateScript([
      "--wait-for-clawhub",
      "true",
      "--force-skip-clawhub",
      "false",
      "--bootstrap-completed",
      "false",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repository is required.");
    expect(result.stdout).toBe("");
  });
});
