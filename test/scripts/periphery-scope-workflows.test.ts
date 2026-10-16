import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const WORKFLOW_CASES = [
  {
    name: "iOS",
    path: ".github/workflows/ios-periphery.yml",
    scopedPath: "apps/ios/Sources/Test.swift",
  },
  {
    name: "macOS",
    path: ".github/workflows/macos-periphery.yml",
    scopedPath: "apps/macos/Sources/OpenClaw/Test.swift",
  },
  {
    name: "shared OpenClawKit",
    path: ".github/workflows/shared-openclawkit-periphery.yml",
    scopedPath: "apps/shared/OpenClawKit/Sources/OpenClawKit/Test.swift",
  },
] as const;

type WorkflowStep = {
  id?: string;
  name?: string;
  with?: {
    "fetch-depth"?: number;
    script?: string;
  };
};

type ScopeWorkflow = {
  on?: {
    pull_request?: {
      paths?: string[];
      types?: string[];
    };
  };
  jobs?: {
    scope?: {
      steps?: WorkflowStep[];
    };
  };
};

type ScopeOptions = {
  diffExitCode?: number;
  repoRoot?: string;
  draft?: boolean;
  eventName?: string;
  files?: Array<string | { filename: string; previous_filename?: string }>;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const require = createRequire(import.meta.url);

function readWorkflow(workflowPath: string): ScopeWorkflow {
  return parse(readFileSync(workflowPath, "utf8")) as ScopeWorkflow;
}

function compileScopeWorkflow(workflowPath: string) {
  const workflow = readWorkflow(workflowPath);
  const step = workflow.jobs?.scope?.steps?.find((candidate) => candidate.id === "scope");
  const script = step?.with?.script;
  if (!script) {
    throw new Error(`missing Periphery scope script in ${workflowPath}`);
  }
  const execute = compileFunction(`return (async () => {\n${script}\n})();`, [
    "context",
    "core",
    "exec",
    "require",
  ]) as (context: unknown, core: unknown, exec: unknown, require: NodeJS.Require) => Promise<void>;
  return { workflow, script, execute };
}

const scopeWorkflows = new Map<string, ReturnType<typeof compileScopeWorkflow>>(
  WORKFLOW_CASES.map(({ path: workflowPath }) => [
    workflowPath,
    compileScopeWorkflow(workflowPath),
  ]),
);

async function runScope(workflowPath: string, options: ScopeOptions): Promise<string | undefined> {
  const outputs = new Map<string, string>();
  const context = {
    eventName: options.eventName ?? "pull_request",
    payload: { pull_request: { draft: options.draft ?? false, number: 123 } },
  };
  const exec = {
    async getExecOutput(command: string, args: string[]) {
      if (command !== "git" || args.slice(0, 5).join(" ") !== "diff --quiet HEAD^1 HEAD --") {
        throw new Error(`unexpected scope command: ${command} ${args.join(" ")}`);
      }
      if (options.diffExitCode !== undefined) {
        return { exitCode: options.diffExitCode };
      }
      if (options.repoRoot) {
        const result = spawnSync(command, args, { cwd: options.repoRoot });
        return { exitCode: result.status ?? 128 };
      }
      const pathspecs = args.slice(5);
      const filenames = (options.files ?? []).flatMap((file) =>
        typeof file === "string"
          ? [file]
          : [file.filename, file.previous_filename].filter((name): name is string => Boolean(name)),
      );
      const matches = (filename: string, pathspec: string) =>
        pathspec.endsWith("/") ? filename.startsWith(pathspec) : filename === pathspec;
      const changed = filenames.some(
        (filename) =>
          pathspecs.some(
            (pathspec) => !pathspec.startsWith(":(exclude)") && matches(filename, pathspec),
          ) &&
          !pathspecs.some(
            (pathspec) =>
              pathspec.startsWith(":(exclude)") && matches(filename, pathspec.slice(10)),
          ),
      );
      return { exitCode: changed ? 1 : 0 };
    },
  };
  const { execute } = scopeWorkflows.get(workflowPath)!;

  await execute(
    context,
    { setOutput: (name: string, value: string) => outputs.set(name, value) },
    exec,
    require,
  );
  return outputs.get("should-scan");
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeFixture(repoRoot: string, relativePath: string, contents: string): void {
  const filePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function makeTempRepoRoot() {
  const root = tempDirs.make("openclaw-periphery-");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "OpenClaw Test"]);
  git(root, ["config", "user.email", "openclaw-test@example.com"]);
  return root;
}

function commit(root: string, message = "fixture") {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
}

describe("Periphery scope workflows", () => {
  it.each(WORKFLOW_CASES)(
    "uses the synthetic merge parent for $name scope",
    ({ path: workflowPath }) => {
      const { workflow, script } = scopeWorkflows.get(workflowPath)!;
      const steps = workflow.jobs?.scope?.steps ?? [];
      const checkout = steps.find((step) => step.name === "Checkout");

      expect(workflow.on?.pull_request?.types).toContain("converted_to_draft");
      expect(workflow.on?.pull_request?.paths).toBeUndefined();
      expect(checkout?.with?.["fetch-depth"]).toBe(2);
      expect(steps.some((step) => step.name === "Ensure base commit")).toBe(false);
      expect(script).toContain('"HEAD^1"');
      expect(script).not.toContain("pulls.listFiles");
    },
  );

  it.each(WORKFLOW_CASES)(
    "selects only $name scope changes",
    async ({ path: workflowPath, scopedPath }) => {
      const check = (options: ScopeOptions, expected: string) =>
        expect(runScope(workflowPath, options)).resolves.toBe(expected);
      await check({ files: [scopedPath] }, "true");
      await check({ files: ["scripts/install-periphery.sh"] }, "true");
      await check({ files: ["docs/index.md"] }, "false");
      await check({ draft: true, files: [scopedPath] }, "false");
      await check({ eventName: "workflow_dispatch" }, "true");
      await check(
        { files: [{ filename: "docs/Moved.swift", previous_filename: scopedPath }] },
        "true",
      );
      await expect(runScope(workflowPath, { diffExitCode: 128 })).rejects.toThrow(
        "git diff failed with exit code 128",
      );
    },
  );

  it.each(WORKFLOW_CASES)(
    "excludes prose but keeps source, mixed changes, resources and renames for $name",
    async ({ path: workflowPath, scopedPath }) => {
      const repoRoot = makeTempRepoRoot();
      writeFixture(repoRoot, "seed", "base\n");
      commit(repoRoot);
      const { script } = scopeWorkflows.get(workflowPath)!;
      const prosePaths = [...script.matchAll(/":\(exclude\)([^"]+)"/g)].flatMap((match) =>
        match[1] ? [match[1]] : [],
      );
      const firstProsePath = prosePaths[0];
      if (!firstProsePath) {
        throw new Error(`missing prose exclusions in ${workflowPath}`);
      }
      for (const prosePath of prosePaths) {
        writeFixture(repoRoot, prosePath, "documentation\n");
      }
      commit(repoRoot);
      await expect(runScope(workflowPath, { repoRoot })).resolves.toBe("false");

      writeFixture(repoRoot, firstProsePath, "updated documentation\n");
      writeFixture(repoRoot, scopedPath, "struct Example {}\n");
      commit(repoRoot);
      await expect(runScope(workflowPath, { repoRoot })).resolves.toBe("true");

      writeFixture(
        repoRoot,
        path.join(path.dirname(scopedPath), "Resources/README.md"),
        "runtime resource\n",
      );
      commit(repoRoot);
      await expect(runScope(workflowPath, { repoRoot })).resolves.toBe("true");

      renameSync(path.join(repoRoot, scopedPath), path.join(repoRoot, firstProsePath));
      commit(repoRoot);
      await expect(runScope(workflowPath, { repoRoot })).resolves.toBe("true");
    },
  );

  it("selects shared scans from native protocol generator inputs", async () => {
    for (const file of [
      "packages/gateway-protocol/src/schema/protocol-schemas.ts",
      "scripts/protocol-gen-swift.ts",
      "scripts/native-protocol-inputs.json",
    ]) {
      await expect(
        runScope(".github/workflows/shared-openclawkit-periphery.yml", { files: [file] }),
      ).resolves.toBe("true");
    }
  });

  it("ignores scoped files added only by base-branch drift", async () => {
    const repoRoot = makeTempRepoRoot();
    writeFixture(repoRoot, "docs/base.md", "base\n");
    commit(repoRoot, "base");
    const eventBase = git(repoRoot, ["rev-parse", "HEAD"]);

    git(repoRoot, ["switch", "-c", "pr"]);
    writeFixture(repoRoot, "docs/pr.md", "pull request\n");
    commit(repoRoot, "pull request");

    git(repoRoot, ["switch", "main"]);
    writeFixture(
      repoRoot,
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Main.swift",
      "struct Main {}\n",
    );
    commit(repoRoot, "advance main");
    git(repoRoot, ["merge", "--no-ff", "pr", "-m", "synthetic merge"]);

    const oldDiff = spawnSync(
      "git",
      ["diff", "--quiet", eventBase, "HEAD", "--", "apps/shared/OpenClawKit/"],
      { cwd: repoRoot },
    );
    expect(oldDiff.status).toBe(1);

    await expect(
      runScope(".github/workflows/shared-openclawkit-periphery.yml", { repoRoot }),
    ).resolves.toBe("false");
    expect(git(repoRoot, ["diff", "--name-only", "HEAD^1", "HEAD"])).toBe("docs/pr.md");
  });
});
