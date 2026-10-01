import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  formatBoundarySelection,
  resolveExtensionBoundarySelection,
  selectAffectedBoundaryPackages,
} from "../../scripts/lib/extension-boundary-selection.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const packages = ["consumer", "direct", "unrelated"];

function fixture() {
  const root = tempDirs.make("boundary-selection-");
  const write = (file: string, contents: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
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
    'import type { Value } from "sdk/value";\nexport type Result = Value[];\n',
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
  it("selects direct owners and transitive type consumers using current edges", () => {
    const { root, commit } = fixture();
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "src/current.ts" },
      { status: "M", path: "extensions/direct/index.ts" },
    ]);
    expect(selection.mode).toBe("affected");
    expect(selection.selected.map((row) => row.package)).toEqual(["consumer", "direct"]);
    expect(selection.skipped.map((row) => row.package)).toEqual(["unrelated"]);
    const summary = formatBoundarySelection(selection);
    expect(summary).toContain("| consumer | selected | transitive source/type dependency:");
    expect(summary).toContain("| unrelated | skipped | unaffected by PR diff;");
    expect(summary).toContain("negative boundary canary still runs");
  });

  it("compares only the PR contribution after main changed an import since the seed", () => {
    const { root, write, commit } = fixture();
    write("src/plugin-sdk/value.ts", 'export type { Value } from "../old.js";\n');
    commit(); // Older cache seed.
    write("src/plugin-sdk/value.ts", 'export type { Value } from "../current.js";\n');
    write("extensions/unrelated/index.ts", "export const unrelated = 2;\n");
    const base = commit();
    write("src/current.ts", "export type Value = boolean;\n");
    commit();
    const selection = resolveExtensionBoundarySelection(root, packages, {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(selection.base).toBe(base);
    expect(selection.selected.map((row) => row.package)).toEqual(["consumer"]);
    expect(selection.skipped.map((row) => row.package)).toEqual(["direct", "unrelated"]);
  });

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

  it("retains consumers when a source is deleted or a new resolution candidate is added", () => {
    for (const operation of ["delete", "add"] as const) {
      const { root, write, commit } = fixture();
      write("src/plugin-sdk/value.ts", 'export type { Value } from "../current";\n');
      if (operation === "add") {
        rmSync(join(root, "src/current.ts"));
        write("src/current/index.ts", "export type Value = number;\n");
      }
      const base = commit();
      if (operation === "delete") {
        rmSync(join(root, "src/current.ts"));
      } else {
        write("src/current.ts", "export type Value = boolean;\n");
      }
      commit();
      const selection = resolveExtensionBoundarySelection(root, packages, {
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
      });
      expect(selection.mode).toBe("affected");
      expect(selection.selected.map((row) => row.package)).toEqual(["consumer"]);
    }
  });

  it("keeps removal of an augmentation full even after the token disappears from HEAD", () => {
    const { root, write, commit } = fixture();
    write(
      "src/current.ts",
      "export {};\ndeclare global { interface Shared { changed: string } }\n",
    );
    const base = commit();
    write("src/current.ts", "export {};\n");
    commit();
    const selection = resolveExtensionBoundarySelection(root, packages, {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(selection.mode).toBe("full");
    expect(selection.reason).toContain("previous global or ambient");
  });

  it("retains compiler filesystem checks for a newly added source symlink", () => {
    const { root, commit } = fixture();
    const base = commit();
    symlinkSync("../current.ts", join(root, "src/plugin-sdk/linked.ts"));
    commit();
    const selection = resolveExtensionBoundarySelection(root, packages, {
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
    });
    expect(selection.mode).toBe("full");
    expect(selection.reason).toContain("nonregular source");
  });

  it.each(["browser", "xai"])(
    "keeps differing declaration aliases full when deleting a %s module",
    (extension) => {
      const { root, write, commit } = fixture();
      const file = `extensions/${extension}/removed.ts`;
      write(file, "export const removed = 1;\n");
      const base = commit();
      rmSync(join(root, file));
      commit();
      const selection = resolveExtensionBoundarySelection(root, [...packages, extension], {
        GITHUB_EVENT_NAME: "pull_request",
        OPENCLAW_CI_EXTENSION_BOUNDARY_BASE: base,
      });
      expect(selection.mode).toBe("full");
      expect(selection.reason).toContain("package declaration aliases differ");
    },
  );

  it("wires the repository kill switch and preflight comparison into the required boundary job", () => {
    const workflow = parse(
      readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    const step = workflow.jobs["check-additional-shard"].steps.find(
      (entry: { name?: string }) => entry.name === "Run additional check shard",
    );
    expect(step.env.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL).toBe(
      "${{ vars.OPENCLAW_CI_EXTENSION_BOUNDARY_FULL }}",
    );
    expect(step.env.OPENCLAW_CI_EXTENSION_BOUNDARY_BASE).toBe(
      "${{ needs.preflight.outputs.diff_base_revision }}",
    );
    expect(step.run).toContain(
      'run_check "test:extensions:package-boundary:canary" pnpm run test:extensions:package-boundary:canary',
    );
  });

  it("keeps an unchanged ambient reference root full even without an import edge", () => {
    const { root, write, commit } = fixture();
    write("src/ambient.d.ts", '/// <reference path="./current.ts" />\ninterface Shared {}\n');
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "src/current.ts" },
    ]);
    expect(selection.mode).toBe("full");
    expect(selection.reason).toContain("opaque declaration/reference root: src/ambient.d.ts");
  });

  it.each(["sdk/value", "../plugin-sdk/value.js"])(
    "limits unchanged augmentation fallback to the affected target of %s",
    (specifier) => {
      const { root, write, commit } = fixture();
      write(
        "src/types/augmentation.d.ts",
        `export {};\ndeclare module "${specifier}" { interface Augmented { extra: string } }\n`,
      );
      commit();
      const affected = selectAffectedBoundaryPackages(root, packages, [
        { status: "M", path: "src/current.ts" },
      ]);
      expect(affected.mode).toBe("full");
      expect(affected.reason).toContain("opaque declaration/reference root:");
      const unrelated = selectAffectedBoundaryPackages(root, packages, [
        { status: "M", path: "extensions/direct/index.ts" },
      ]);
      expect(unrelated.mode).toBe("affected");
      expect(unrelated.selected.map((row) => row.package)).toEqual(["direct"]);
    },
  );

  it("parses declaration signatures and ordinary TypeScript without treating generics as JSX", () => {
    const { root, write, commit } = fixture();
    write(
      "src/types/vendor.d.ts",
      'export function moduleFactory<T>(value: T): T;\ndeclare module "vendor" { function identity<T>(value: T): T; }\n',
    );
    write(
      "extensions/direct/index.ts",
      'export const identity = <T>(value: T): T => value;\nexport const value = <number>1;\nexport const moduleName = "direct";\n',
    );
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "extensions/direct/index.ts" },
    ]);
    expect(selection.mode).toBe("affected");
    expect(selection.selected.map((row) => row.package)).toEqual(["direct"]);
  });

  it("keeps unresolved workspace augmentation targets full", () => {
    const { root, write, commit } = fixture();
    write(
      "src/types/augmentation.d.ts",
      'export {};\ndeclare module "@openclaw/missing" { interface Augmented {} }\n',
    );
    commit();
    const selection = selectAffectedBoundaryPackages(root, packages, [
      { status: "M", path: "extensions/direct/index.ts" },
    ]);
    expect(selection.mode).toBe("full");
    expect(selection.reason).toContain("opaque declaration/reference root:");
  });

  it("falls back for topology, ambient declarations and unknown source membership", () => {
    const { root, commit } = fixture();
    commit();
    for (const change of [
      { status: "M", path: "pnpm-lock.yaml" },
      { status: "M", path: "extensions/direct/tsconfig.json" },
      { status: "M", path: "src/types/globals.d.ts" },
      { status: "D", path: "src/current.ts" },
      { status: "A", path: "src/added.ts" },
      { status: "T", path: "extensions/direct/index.ts" },
    ]) {
      expect(selectAffectedBoundaryPackages(root, packages, [change]).mode).toBe("full");
    }
    expect(
      selectAffectedBoundaryPackages(root, packages, [{ status: "M", path: "README.md" }]).selected,
    ).toEqual([]);
  });
});
