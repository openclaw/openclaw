import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("native prepare-gates comparison base", () => {
  it("accepts inherited growth at the captured fork but rejects new candidate growth", () => {
    const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-gate-base-"));
    const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
    const loader = quote(join(process.cwd(), "scripts/tsx.mjs"));
    const node = quote(process.execPath);
    const pnpm = join(f.root, "bin/pnpm");
    // Retain the native gate, aggregate scheduler, and real line-cap measurement.
    // Other command bodies are outside this comparison contract.
    writeFileSync(
      pnpm,
      [
        "#!/bin/sh",
        'command="$1"',
        "shift",
        'case "$command" in',
        `  check) exec ${node} --import ${loader} ${quote(join(process.cwd(), "scripts/check.mts"))} "$@" ;;`,
        `  check:line-cap-ratchet) exec ${node} --import ${loader} ${quote(join(process.cwd(), "scripts/check-line-cap-ratchet.mts"))} "$@" ;;`,
        "  *) exit 0 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(pnpm, 0o755);
    Object.assign(f.env, {
      OPENCLAW_TESTBOX: "",
      OPENCLAW_PR_GATES_REMOTE: "",
      GITHUB_ACTIONS: "",
    });
    const prepared = f.run("prepare-init");
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);

    const source = (lines: number) =>
      Array.from({ length: lines }, (_, index) => `export const value${index} = ${index};`).join(
        "\n",
      ) + "\n";
    writeFileSync(
      join(f.canonical, ".oxlintrc.json"),
      JSON.stringify({
        overrides: [
          {
            files: ["src/**/*.ts"],
            rules: { "max-lines": ["warn", { max: 3, skipBlankLines: true, skipComments: true }] },
          },
        ],
      }),
    );
    writeFileSync(join(f.canonical, "src/inherited.ts"), source(4));
    f.git(f.canonical, "add", ".oxlintrc.json", "src/inherited.ts");
    f.git(f.canonical, "commit", "-qm", "test: inherited main debt");
    const integratedMain = f.git(f.canonical, "rev-parse", "HEAD");
    f.git(f.worktree, "merge", "--no-ff", integratedMain, "-m", "test: incorporate main");
    const candidate = f.git(f.worktree, "rev-parse", "HEAD");

    // Main later shrinks the debt; the candidate still owns its fork's allowance.
    writeFileSync(join(f.canonical, "src/inherited.ts"), source(3));
    f.git(f.canonical, "commit", "-qam", "test: later main cleanup");
    const capturedMain = f.git(f.canonical, "rev-parse", "HEAD");
    f.git(f.canonical, "push", "origin", `${capturedMain}:refs/heads/main`);
    f.git(f.canonical, "checkout", "--detach", f.main);
    f.git(f.canonical, "update-ref", "refs/remotes/origin/main", f.main);

    const accepted = f.run("prepare-gates");
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(readFileSync(join(f.local, "gates-check.log"), "utf8")).toContain(
      "Line-cap ratchet OK:",
    );
    const stampPath = join(f.local, "gates.env");
    const stamp = readFileSync(stampPath, "utf8");
    expect(stamp).toContain("GATES_MODE=full\n");
    expect(stamp).toContain(`FULL_GATES_HEAD_SHA=${candidate}\n`);
    expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(capturedMain);
    expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(f.main);

    writeFileSync(join(f.worktree, "src/inherited.ts"), source(5));
    f.git(f.worktree, "commit", "-qam", "test: candidate grows inherited debt");
    const rejected = f.run("prepare-gates");
    expect(rejected.status, rejected.stdout + rejected.stderr).not.toBe(0);
    expect(readFileSync(join(f.local, "gates-check.log"), "utf8")).toContain(
      "src/inherited.ts: 4 -> 5 counted lines (cap 3)",
    );
    expect(readFileSync(stampPath, "utf8")).toBe(stamp);
    expect(f.git(f.worktree, "rev-parse", "FETCH_HEAD")).toBe(capturedMain);
    expect(f.git(f.canonical, "rev-parse", "refs/remotes/origin/main")).toBe(f.main);
  });
});
