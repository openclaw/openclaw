import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("../../scripts/ci-collect-checks.sh", import.meta.url));
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const run = (args: string[]) => spawnSync(bash, args, { encoding: "utf8" });
const collect = (commands: string, ...args: string[]) =>
  run(["-euo", "pipefail", "-c", `source "$1"\n${commands}`, "check-collection", helper, ...args]);

describe.skipIf(process.platform === "win32")("CI independent check collection", () => {
  it.each([
    ["all successful", 0, 0],
    ["first check fails", 17, 1],
  ])("collects %s without changing argument boundaries", (_name, firstExit, expectedExit) => {
    const result = collect(
      String.raw`run_check first bash -c 'printf "first\n"; exit "$1"' check "$2"
run_check second printf "second: <%s>\n" "one argument" ""
finish_checks`,
      String(firstExit),
    );

    expect(result.status, result.stderr).toBe(expectedExit);
    expect(result.stdout).toContain("first\n");
    expect(result.stdout).toContain("second: <one argument>\nsecond: <>\n");
    expect(result.stdout).toContain("[ok] second");
    if (firstExit !== 0) {
      expect(result.stdout).toContain("first failed (exit 17)");
    }
  });

  it("retains setup failure inside a function while running the next independent check", () => {
    const result =
      collect(String.raw`dependent_check() { false; printf 'unreachable artifact check\n'; }
run_check dependent dependent_check
run_check independent printf 'independent check\n'
finish_checks
printf 'unreachable successful finish\n'`);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("dependent failed");
    expect(result.stdout).toContain("independent check\n");
    expect(result.stdout).not.toContain("unreachable");
  });

  it("runs every CLI command and retains pipeline failure and shell quoting", () => {
    const result = run([
      helper,
      "printf 'first\\n'; false | cat",
      "printf 'second: <%s>\\n' 'quoted argument'",
      "printf 'third\\n'; exit 23",
    ]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("first\n");
    expect(result.stdout).toContain("second: <quoted argument>\n");
    expect(result.stdout).toContain("third\n");
    expect(result.stdout).toContain("failed (exit 1)");
    expect(result.stdout).toContain("failed (exit 23)");
  });

  it.each([124, 130, 137])("stops admitting checks after deadline or signal exit %s", (exit) => {
    const result = collect(
      String.raw`run_check stopped bash -c 'exit "$1"' check "$2"
run_check later printf 'unreachable check\n'
finish_checks`,
      String(exit),
    );

    expect(result.status, result.stderr).toBe(exit);
    expect(result.stdout).toContain(`stopped failed (exit ${exit})`);
    expect(result.stdout).not.toContain("unreachable");
    expect(result.stdout).not.toContain("::group::later");
  });
});
