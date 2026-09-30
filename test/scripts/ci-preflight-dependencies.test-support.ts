import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Execute the workflow's native Node manifest with runtime dependencies forbidden. */
export function runDependencyFreePreflight(
  entrypoint: URL,
  directory: string,
  nodeExecPath: string,
) {
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
        /\/(managed-windows-job|service-child-windows-job-native)\.[cm]?[jt]s$/.test(resolved.url)) {
      throw new Error("Unexpected preflight runtime module: " + resolved.url);
    }
    return resolved;
  },
});
`,
  );
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCLAW_CI_") || key === "NODE_OPTIONS" || key === "NODE_PATH") {
      delete env[key];
    }
  }
  const result = spawnSync(nodeExecPath, ["--import", preload, fileURLToPath(entrypoint)], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: {
      ...env,
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
      // Exercise real planner and codec imports without a repository-wide PR
      // owner graph. Changed-owner selection has separate integration coverage.
      OPENCLAW_CI_CHANGED_PATHS_JSON: "[]",
    },
  });
  return {
    result,
    manifest: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}
