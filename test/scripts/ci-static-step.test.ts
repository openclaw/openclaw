import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/ci-static-step.sh", import.meta.url));

function runChecks(kind: string, status: number, evidence: string) {
  return spawnSync(
    "bash",
    [
      "-euc",
      `source "$1" "$2"
check() { printf 'checked:%s\\n' "$1"; return "$2"; }
run_static_check check first "$3"
run_static_check check second 0
run_static_check check third 7
finish_static_checks`,
      "ci-static-test",
      script,
      kind,
      String(status),
    ],
    { encoding: "utf8", env: { ...process.env, OPENCLAW_CI_STATIC_EVIDENCE: evidence } },
  );
}

describe.skipIf(process.platform === "win32")("CI static check collection", () => {
  it.each([
    { kind: "tsgo", status: 2, evidence: "0" },
    { kind: "oxlint", status: 1, evidence: "0" },
    { kind: "tsgo", status: 23, evidence: "1" },
    { kind: "oxlint", status: 23, evidence: "1" },
  ])(
    "runs every group after $kind exits $status, retaining failure",
    ({ kind, status, evidence }) => {
      const result = runChecks(kind, status, evidence);
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout.trim().split("\n")).toEqual([
        "checked:first",
        "checked:second",
        "checked:third",
        `[ci-static:${kind}:step] {"version":1,"groups":3}`,
      ]);
    },
  );

  it.each([124, 130, 143])(
    "stops admitting groups after timeout or cancellation exit %s",
    (status) => {
      const result = runChecks("tsgo", status, "0");
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout).toBe("checked:first\n");
    },
  );
});
