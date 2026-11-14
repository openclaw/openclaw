import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cleanEnv = (exclude: RegExp) =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !exclude.test(key)));

export function exportPreflightHarness(directory: string): string {
  const workspace = path.join(directory, "workspace");
  const env = cleanEnv(/^GIT_/i);
  execFileSync("git", ["init", "--quiet", workspace], { env });
  const gitPaths = [`--git-dir=${path.join(workspace, ".git")}`, `--work-tree=${process.cwd()}`];
  execFileSync("git", [...gitPaths, "add", "--", ".github/actions", "scripts"], { env });
  const result = spawnSync(
    "python3",
    ["-I", "-S", ".github/actions/git-owner/owner.py", "--policy", "-"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, WORKFLOW_SHA: "a".repeat(40) },
      input: `import os
import ci_git_owner
ci_git_owner.kind = "preflight"
ci_git_owner.workspace = ${JSON.stringify(workspace)}
ci_git_owner.checkout_harness(os.environ["WORKFLOW_SHA"])
`,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Preflight harness export failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return path.join(workspace, ".ci-harness");
}

export function runDependencyFreePreflight(entrypoint: URL, directory: string, node: string) {
  const preload = path.join(directory, "preflight-import-guard.mjs");
  const output = path.join(directory, "github-output.txt");
  writeFileSync(
    preload,
    String.raw`
import { isBuiltin, registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && !specifier.startsWith(".") &&
        !specifier.startsWith("file:") && !specifier.startsWith("/")) {
      throw new Error("Unexpected preflight dependency: " + specifier);
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes("/node_modules/") ||
        /\/(managed-windows-job)\.[cm]?[jt]s$/.test(resolved.url)) {
      throw new Error("Unexpected preflight runtime module: " + resolved.url);
    }
    return resolved;
  },
});
`,
  );
  const result = spawnSync(node, ["--import", preload, fileURLToPath(entrypoint)], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: {
      ...cleanEnv(/^(?:OPENCLAW_CI_|NODE_OPTIONS$|NODE_PATH$)/),
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ATTEMPT: "1",
      OPENCLAW_CI_EVENT_NAME: "workflow_dispatch",
      OPENCLAW_CI_REPOSITORY: "openclaw/openclaw",
      OPENCLAW_CI_HEAD_REPOSITORY: "openclaw/openclaw",
      OPENCLAW_CI_RUNNER_PROFILE: "github",
      OPENCLAW_CI_RUN_NODE: "false",
      OPENCLAW_CI_RUN_WINDOWS: "true",
      OPENCLAW_CI_RUN_UI_TESTS: "true",
      OPENCLAW_CI_CHANGED_PATHS_JSON: "[]",
    },
  });
  return { result, manifest: existsSync(output) ? readFileSync(output, "utf8") : "" };
}
