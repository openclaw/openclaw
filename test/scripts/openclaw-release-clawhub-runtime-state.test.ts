import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const SCRIPT_PATH = resolve("scripts/openclaw-release-clawhub-runtime-state.ts");
const TSX_LOADER = import.meta.resolve("tsx");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runRuntimeStateScript(
  overrides: Record<string, string | undefined> = {},
  cwd = process.cwd(),
) {
  const args = Object.entries({
    repository: "openclaw/openclaw",
    "wait-for-clawhub": "true",
    "force-skip-clawhub": "false",
    "bootstrap-completed": "true",
    ...overrides,
  }).flatMap(([key, value]) => (value === undefined ? [] : [`--${key}`, value]));
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
        { "normal-run-id": "123", "bootstrap-run-id": "456" },
        cwd,
      );

      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        verifierArgs: ["--plugin-clawhub-run", "123", "--plugin-clawhub-bootstrap-run", "456"],
        proofLines: {
          normal: "- plugin ClawHub publish: https://github.com/openclaw/openclaw/actions/runs/123",
          bootstrap:
            "- plugin ClawHub bootstrap: https://github.com/openclaw/openclaw/actions/runs/456",
        },
      });
    },
  );

  it.each([
    { staged: true, failed: false },
    { staged: true, failed: true },
    { staged: false, failed: true },
  ])(
    "keeps parent publication proof consistent (staged=$staged, failed=$failed)",
    ({ staged, failed }) => {
      const result = runRuntimeStateScript({
        "force-skip-clawhub": String(failed),
        "normal-publication-staged": String(staged),
        "normal-run-id": "123",
        "bootstrap-run-id": "456",
      });
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

  it.each([
    [{ "wait-for-clawhub": "yes" }, "--wait-for-clawhub must be true or false."],
    [{ repository: undefined }, "--repository is required."],
  ] as const)("rejects invalid arguments %j before emitting runtime state", (flags, error) => {
    const result = runRuntimeStateScript({ ...flags, "bootstrap-completed": "false" });
    expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining(error), stdout: "" });
  });
});
