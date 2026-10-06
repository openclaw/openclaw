import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function fixture() {
  const root = tempDirs.make("boundary-selection-");
  const write = (file: string, contents: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
  write("scripts/lib/plugin-sdk-entrypoints.json", JSON.stringify(["value", "private"]));
  write("scripts/lib/plugin-sdk-private-local-only-subpaths.json", JSON.stringify(["private"]));
  write("package.json", '{"type":"module"}');
  write(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { paths: { "sdk/*": ["src/plugin-sdk/*.ts"] } } }),
  );
  write("src/old.ts", "export type Value = string;\n");
  write("src/current.ts", "export type Value = number;\n");
  write("src/plugin-sdk/value.ts", 'export type { Value } from "../current.js";\n');
  write(
    "extensions/consumer/index.ts",
    'import type { Value } from "openclaw/plugin-sdk/value";\nexport type Result = Value[];\n',
  );
  write("extensions/direct/index.ts", "export const direct = 1;\n");
  write("extensions/unrelated/index.ts", "export const unrelated = 1;\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Boundary fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Boundary fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  git("init", "-q");
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { root, write, git, commit };
}

describe("extension package PR selection", () => {
  it("selects touched packages and a bounded smoke set instead of transitive core consumers", () => {
    const { root, commit } = fixture();
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "src/current.ts" },
      { status: "M", path: "extensions/direct/index.ts" },
    ]);
    expect(selection.selected.map((row) => row.package)).toEqual([
      "direct",
      "telegram",
      "codex",
      "slack",
    ]);
    expect(selection.skipped.map((row) => row.package)).toEqual(["consumer", "unrelated"]);
    const summary = formatBoundarySelection(selection);
    expect(summary).toContain("| telegram | selected | SDK smoke sample");
    expect(summary).toContain("| consumer | skipped | outside PR selection;");
    expect(summary).toContain("negative boundary canary still runs");
  });

  it.each([
    'import type { Value } from "openclaw/plugin-sdk/value"; export type Result = Value;',
    'export type { Value } from "openclaw/plugin-sdk/value";',
    'export type Result = import("openclaw/plugin-sdk/value").Value;',
    'export const load = () => import("openclaw/plugin-sdk/value");',
    'import type { Value } from "openclaw/plugin-sdk/value"; export const options = { onRequest: true ? async (value, context): Promise<Value> => value : undefined };',
  ])("selects direct public-entry consumers for %s", (source) => {
    const { root, write, commit } = fixture();
    write("extensions/consumer/index.ts", source);
    write(
      "extensions/unrelated/index.ts",
      '// import "openclaw/plugin-sdk/value";\nexport const text = \'import "openclaw/plugin-sdk/value";\';\n',
    );
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "src/plugin-sdk/value.ts" },
    ]);
    expect(selection.selected.map((row) => row.package)).toEqual([
      "consumer",
      "telegram",
      "codex",
      "slack",
    ]);
    expect(selection.selected[0]?.reason).toContain("direct import of changed public entry");
  });

  it("uses the base inventory for a deleted public entry, while private entries only select smoke", () => {
    const { root, write, commit } = fixture();
    const base = commit();
    rmSync(join(root, "src/plugin-sdk/value.ts"));
    write("scripts/lib/plugin-sdk-entrypoints.json", '["private"]');
    commit();
    const deleted = resolveExtensionBoundarySelection(root, packages, {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(deleted.selected.map((row) => row.package)).toEqual([
      "consumer",
      "telegram",
      "codex",
      "slack",
    ]);
    expect(
      selectAffectedBoundaryPackages(root, packages, [
        { status: "M", path: "src/plugin-sdk/private.ts" },
      ]).selected.map((row) => row.package),
    ).toEqual(["telegram", "codex", "slack"]);
  });

  it("excludes main drift since the cache seed from the PR contribution", () => {
    const { root, write, commit } = fixture();
    commit();
    write("src/plugin-sdk/value.ts", 'export type { Value } from "../old.js";\n');
    const base = commit();
    write("extensions/direct/index.ts", "export const direct = 2;\n");
    commit();
    const selection = resolveExtensionBoundarySelection(root, packages, {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(selection.base).toBe(base);
    expect(selection.selected.map((row) => row.package)).toEqual(["direct"]);
  });

  it.each(["package", "core", "deleted-public-entry"])(
    "selects %s changes after the shared base fetch in a depth-one PR checkout",
    (change) => {
      const { root, write, git, commit } = fixture();
      const common = commit();
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
      write("extensions/unrelated/index.ts", "export const unrelated = 2;\n");
      const base = commit();
      git("-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "-qm", "PR merge", pullHead);
      const merge = git("rev-parse", "HEAD");
      git("config", "uploadpack.allowFilter", "true");
      const checkout = tempDirs.make("boundary-shallow-");
      const checkoutGit = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: checkout,
          encoding: "utf8",
          stdio: "pipe",
        }).trim();
      checkoutGit(
        "clone",
        "--depth=1",
        "--branch=main",
        "--no-checkout",
        pathToFileURL(root).href,
        ".",
      );
      checkoutGit("checkout", "--detach", merge);
      expect(checkoutGit("rev-parse", "--is-shallow-repository")).toBe("true");
      expect(() => checkoutGit("cat-file", "-e", `${base}^{commit}`)).toThrow();
      const env = { GITHUB_EVENT_NAME: "pull_request", OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base };
      const missing = resolveExtensionBoundarySelection(checkout, packages, env);
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
      const selected = resolveExtensionBoundarySelection(checkout, packages, env);
      expect(selected.mode).toBe("affected");
      expect(selected.selected.map((row) => row.package)).toEqual(
        change === "package"
          ? ["direct"]
          : change === "core"
            ? ["telegram", "codex", "slack"]
            : ["consumer", "telegram", "codex", "slack"],
      );
      expect(missing.reason).toContain("comparison base unavailable in checkout");
      // Another fetched parent is not the pinned main contribution boundary.
      checkoutGit("fetch", "--no-tags", "--depth=1", "origin", pullHead);
      expect(
        resolveExtensionBoundarySelection(checkout, packages, {
          ...env,
          OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: pullHead,
        }).mode,
      ).toBe("full");
    },
  );

  it("keeps schedule, release, the kill switch and uncertain comparisons full", () => {
    const { root, commit } = fixture();
    const base = commit();
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
      expect(selection.selected.map((row) => row.package)).toEqual(packages);
      expect(selection.skipped).toEqual([]);
    }
  });

  it("bounds declaration, dependency and module-membership changes without widening unrelated files", () => {
    const { root, commit } = fixture();
    commit();
    for (const change of [
      { status: "M", path: "pnpm-lock.yaml" },
      { status: "M", path: "src/types/globals.d.ts" },
      { status: "D", path: "src/current.ts" },
      { status: "A", path: "src/added.ts" },
    ]) {
      expect(
        selectAffectedBoundaryPackages(root, packages, [change]).selected.map((row) => row.package),
      ).toEqual(["telegram", "codex", "slack"]);
    }
    for (const path of ["extensions/direct/tsconfig.json", "extensions/direct/index.ts"]) {
      expect(
        selectAffectedBoundaryPackages(root, packages, [{ status: "T", path }]).selected.map(
          (row) => row.package,
        ),
      ).toEqual(["direct"]);
    }
    for (const path of ["README.md", "ui/src/app.ts", "src/current.test.ts"]) {
      expect(
        selectAffectedBoundaryPackages(root, packages, [{ status: "M", path }]).selected,
      ).toEqual([]);
    }
  });

  it("retains the touched owner for deleted Browser/XAI aliases and nonregular sources", () => {
    const { root, write, commit } = fixture();
    for (const extension of ["browser", "xai"]) {
      write(`extensions/${extension}/removed.ts`, "export {};\n");
    }
    const base = commit();
    rmSync(join(root, "extensions/browser/removed.ts"));
    rmSync(join(root, "extensions/xai/removed.ts"));
    symlinkSync("../../src/current.ts", join(root, "extensions/direct/linked.ts"));
    commit();
    const selection = resolveExtensionBoundarySelection(root, [...packages, "browser", "xai"], {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(selection.selected.map((row) => row.package)).toEqual(["direct", "browser", "xai"]);
  });

  it("wires the repository kill switch, comparison and negative canary into the required boundary job", () => {
    const workflow = parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const step = workflow.jobs["check-additional-shard"].steps.find(
      (entry: { name?: string }) => entry.name === "Run additional check shard",
    );
    const baseStep = workflow.jobs["check-additional-shard"].steps.find(
      (entry: { name?: string }) => entry.name === "Ensure additional check comparison base",
    );
    expect(baseStep.uses).toBe("./.ci-harness/.github/actions/ensure-base-commit");
    expect(baseStep.with["base-sha"]).toBe("${{ needs.preflight.outputs.diff_base_revision }}");
    expect(step.env.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL).toBe(
      "${{ vars.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL }}",
    );
    expect(step.env.OPENCLAW_CI_EXTENSION_BOUNDARY_BASE).toBe(
      "${{ needs.preflight.outputs.diff_base_revision }}",
    );
    expect(step.run).toBe("bash .ci-harness/scripts/ci-additional-checks.sh");
    expect(
      readFileSync(new URL("../../scripts/ci-additional-checks.sh", import.meta.url), "utf8"),
    ).toContain(
      'run_check "test:extensions:package-boundary:canary" pnpm run test:extensions:package-boundary:canary',
    );
  });
});
