import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  renderGitTestClock,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";

it.skipIf(process.platform !== "win32")(
  "settles original member handles before the Git owner returns",
  async () => {
    await withCiCheckoutFixture(
      "harness-timeout",
      (root) => {
        const source = readFileSync(".github/actions/git-owner/owner.py", "utf8");
        const probe = path.join(root, "settlement-probe.py");
        writeFileSync(
          probe,
          readFileSync("test/scripts/fixtures/ci-git-owner-settlement-probe.py"),
        );
        const observed = source.replace(
          'if __name__ == "__main__":',
          `exec(compile(open(os.environ["OWNER_SETTLEMENT_PROBE"]).read(), "<settlement-probe>", "exec"))\nif __name__ == "__main__":`,
        );
        const step = readCiCheckoutStep("checks-windows").run;
        const quoted = source.replaceAll("'", "'\\''");
        expect(step).toContain(quoted);
        const run = step.replace(quoted, observed.replaceAll("'", "'\\''"));
        writeFileSync(
          path.join(root, "fixture-options.json"),
          JSON.stringify({ env: { OWNER_SETTLEMENT_ROOT: root, OWNER_SETTLEMENT_PROBE: probe } }),
        );
        writeFileSync(path.join(root, "checkout.sh"), renderGitTestClock(run, { realDrain: true }));
      },
      (report, result, stderr, root) => {
        expect(result, stderr + report.output).toEqual({ code: 0, signal: null });
        expectCiCheckoutCleanup(report);
        expect(report.code, report.output).toBe(124);
        expect(report.commands.filter(({ args }) => args[0] === "fetch")).toHaveLength(2);
        const observations = readFileSync(path.join(root, "settlement.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { wait: number }[]);
        expect(
          observations.some((entry) => entry.length >= 3),
          "must observe parent, child and grandchild at original return",
        ).toBe(true);
        expect(observations.flat().every((entry) => entry.wait === 0)).toBe(true);
      },
    );
  },
  55_000,
);

it.skipIf(process.platform !== "win32")(
  "rejects reused PIDs and racing job members without touching the sentinel",
  () => {
    const result = execFileSync(
      "python",
      [
        "-I",
        "-S",
        "test/scripts/fixtures/ci-git-owner-settlement-safety.py",
        ".github/actions/git-owner/owner.py",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const cases = JSON.parse(result) as { fault: string; sentinelPreserved: boolean }[];
    expect(cases.map((entry) => entry.fault)).toEqual([
      "reused-pid",
      "member-race",
      "termination-race",
    ]);
    expect(cases.every((entry) => entry.sentinelPreserved)).toBe(true);
  },
);
