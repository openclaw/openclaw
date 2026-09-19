import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Execute the workflow's native Node manifest with runtime dependencies forbidden. */
export function runDependencyFreePreflight(
  source: string,
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
    // CI materializes these unchanged trusted helpers under its harness checkout.
    if (specifier.startsWith("./.ci-harness/")) {
      specifier = "./" + specifier.slice("./.ci-harness/".length);
    }
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
  const result = spawnSync(nodeExecPath, ["--import", preload, "--input-type=module"], {
    cwd: process.cwd(),
    input: source,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: {
      ...env,
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_RUN_ATTEMPT: "1",
      OPENCLAW_CI_EVENT_NAME: "pull_request",
      OPENCLAW_CI_REPOSITORY: "openclaw/openclaw",
      OPENCLAW_CI_HEAD_REPOSITORY: "openclaw/openclaw",
      OPENCLAW_CI_RUNNER_PROFILE: "github",
      OPENCLAW_CI_RUN_NODE: "true",
      OPENCLAW_CI_RUN_WINDOWS: "true",
      OPENCLAW_CI_CHANGED_PATHS_JSON: '["scripts/lib/managed-child-process.mts"]',
    },
  });
  return {
    result,
    manifest: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}
