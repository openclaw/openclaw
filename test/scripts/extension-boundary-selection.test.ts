import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  formatBoundarySelection,
  resolveExtensionBoundarySelection,
  selectAffectedBoundaryPackages,
} from "../../scripts/lib/extension-boundary-selection.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packages = ["consumer", "direct", "unrelated", "telegram", "codex", "slack"];
const smoke = ["telegram", "codex", "slack"];
const selectedPackages = (selection: ReturnType<typeof selectAffectedBoundaryPackages>) =>
  selection.selected.map((row) => row.package);
function gitIn(cwd: string) {
  return (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Boundary fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Boundary fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
}

function fixture(overrides: Record<string, string> = {}) {
  const root = tempDirs.make("boundary-selection-");
  const write = (file: string, contents: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
  write("scripts/lib/plugin-sdk-entrypoints.json", JSON.stringify(["value", "private"]));
  write("scripts/lib/plugin-sdk-private-local-only-subpaths.json", JSON.stringify(["private"]));
  write("package.json", '{"type":"module"}');
  write("src/current.ts", "export type Value = number;\n");
  write("src/plugin-sdk/value.ts", 'export type { Value } from "../current.js";\n');
  write(
    "extensions/consumer/index.ts",
    'import type { Value } from "openclaw/plugin-sdk/value";\nexport type Result = Value[];\n',
  );
  write("extensions/direct/index.ts", "export const direct = 1;\n");
  write("extensions/unrelated/index.ts", "export const unrelated = 1;\n");
  const git = gitIn(root);
  git("init", "-q");
  const commit = (files: Record<string, string> = {}) => {
    for (const [file, contents] of Object.entries(files)) {
      write(file, contents);
    }
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  const head = commit(overrides);
  const select = (...paths: string[]) =>
    selectAffectedBoundaryPackages(
      root,
      packages,
      paths.map((path) => ({ path, status: "M" })),
    );
  return { root, write, git, commit, head, select };
}

describe("extension package PR selection", () => {
  it("selects touched packages and a bounded smoke set instead of transitive core consumers", () => {
    const { select } = fixture();
    const selection = select("src/current.ts", "extensions/direct/index.ts");
    expect(selectedPackages(selection)).toEqual(["direct", ...smoke]);
    expect(selection.skipped.map((row) => row.package)).toEqual(["consumer", "unrelated"]);
    const summary = formatBoundarySelection(selection);
    expect(summary).toContain("| telegram | selected | SDK smoke sample");
    expect(summary).toContain("| consumer | skipped | outside PR selection;");
    expect(summary).toContain("negative boundary canary still runs");
  });

  it.each([
    'export type { Value } from "openclaw/plugin-sdk/value";',
    'export type Result = import("openclaw/plugin-sdk/value").Value;',
    'export const load = () => import("openclaw/plugin-sdk/value");',
  ])("selects direct public-entry consumers for %s", (source) => {
    const { select } = fixture({
      "extensions/consumer/index.ts": source,
      "extensions/unrelated/index.ts":
        '// import "openclaw/plugin-sdk/value";\nexport const text = \'import "openclaw/plugin-sdk/value";\';\n',
    });
    const selection = select("src/plugin-sdk/value.ts");
    expect(selectedPackages(selection)).toEqual(["consumer", ...smoke]);
    expect(selection.selected[0]?.reason).toContain("direct import of changed public entry");
  });

  it.each(["package", "core", "deleted-public-entry"])(
    "selects %s changes after the shared base fetch in a depth-one PR checkout",
    (change) => {
      const { root, write, git, commit, head: common } = fixture();
      git("checkout", "-qb", "pull-head");
      if (change === "package") {
        write("extensions/direct/index.ts", "export const direct = 2;\n");
      } else if (change === "core") {
        write("src/current.ts", "export type Value = boolean;\n");
      } else {
        rmSync(join(root, "src/plugin-sdk/value.ts"));
        write("scripts/lib/plugin-sdk-entrypoints.json", '["private"]');
      }
      const pullHead = commit();
      git("checkout", "-B", "main", common);
      const base = commit({ "extensions/unrelated/index.ts": "export const unrelated = 2;\n" });
      git("-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "-qm", "PR merge", pullHead);
      const merge = git("rev-parse", "HEAD");
      const checkout = tempDirs.make("boundary-shallow-");
      const checkoutGit = gitIn(checkout);
      checkoutGit("clone", "--depth=1", pathToFileURL(root).href, ".");
      checkoutGit("checkout", "--detach", merge);
      expect(checkoutGit("rev-parse", "--is-shallow-repository")).toBe("true");
      expect(() => checkoutGit("cat-file", "-e", `${base}^{commit}`)).toThrow();
      const select = (revision: string) =>
        resolveExtensionBoundarySelection(checkout, packages, {
          GITHUB_EVENT_NAME: "pull_request",
          OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: revision,
        });
      const missing = select(base);
      expect(missing.mode).toBe("full");
      const action = execFileSync(
        process.platform === "win32" ? "python" : "python3",
        [
          "-I",
          "-S",
          resolve(".github/actions/git-owner/owner.py"),
          "--policy",
          resolve(".github/actions/ensure-base-commit/policy.py"),
        ],
        {
          cwd: checkout,
          encoding: "utf8",
          env: { ...process.env, BASE_SHA: base, FETCH_REF: "main" },
        },
      );
      expect(action).toContain("Resolved base commit after exact fetch:");
      expect(checkoutGit("rev-parse", "HEAD")).toBe(merge);
      expect(checkoutGit("rev-list", "--count", "HEAD")).toBe("1");
      expect(() => checkoutGit("merge-base", base, "HEAD")).toThrow();
      const selected = select(base);
      expect(selected.mode).toBe("affected");
      expect(selectedPackages(selected)).toEqual(
        change === "package" ? ["direct"] : change === "core" ? smoke : ["consumer", ...smoke],
      );
      expect(missing.reason).toContain("comparison base unavailable in checkout");
      // Another fetched parent is not the pinned main contribution boundary.
      checkoutGit("fetch", "--no-tags", "--depth=1", "origin", pullHead);
      expect(select(pullHead).mode).toBe("full");
    },
  );

  it("keeps schedule, release, the kill switch and uncertain comparisons full", () => {
    const { root, head: base } = fixture();
    for (const env of [
      { GITHUB_EVENT_NAME: "schedule" },
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      { GITHUB_EVENT_NAME: "release" },
      { GITHUB_EVENT_NAME: "pull_request" },
      ...["1", "true", "full"].map((value) => ({
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
        OPENCLAW_CI_EXTENSION_BOUNDARY_FULL: value,
      })),
    ]) {
      const selection = resolveExtensionBoundarySelection(root, packages, env);
      expect(selection.mode).toBe("full");
      expect(selectedPackages(selection)).toEqual(packages);
      expect(selection.skipped).toEqual([]);
    }
  });

  it("wires the repository kill switch, comparison and negative canary into the required boundary job", () => {
    const workflow = parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const step = (name: string) =>
      workflow.jobs["check-additional-shard"].steps.find(
        (entry: { name?: string }) => entry.name === name,
      );
    const base = "${{ needs.preflight.outputs.diff_base_revision }}";
    expect(step("Ensure additional check comparison base")).toMatchObject({
      uses: "./.ci-harness/.github/actions/ensure-base-commit",
      with: { "base-sha": base },
    });
    expect(step("Run additional check shard")).toMatchObject({
      env: {
        OPENCLAW_CI_EXTENSION_BOUNDARY_FULL: "${{ vars.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL }}",
        OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
      },
      run: "bash .ci-harness/scripts/ci-additional-checks.sh",
    });
    expect(
      readFileSync(new URL("../../scripts/ci-additional-checks.sh", import.meta.url), "utf8"),
    ).toContain(
      'run_check "test:extensions:package-boundary:canary" pnpm run test:extensions:package-boundary:canary',
    );
  });
});
