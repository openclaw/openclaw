import { execFileSync } from "node:child_process";
import { constants as fsConstants, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

export const SCRIPT_PATH = resolve("scripts/full-release-validation-at-sha.mjs");
export const testNodeExecPath = resolveTestNodeExecPath();
export const CURRENT_WORKFLOW_SOURCE = readFileSync(
  ".github/workflows/full-release-validation.yml",
  "utf8",
);
export const CONTRACT_ONE_WORKFLOW_SOURCE = CURRENT_WORKFLOW_SOURCE.replace(
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "2"',
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "1"',
).replace('  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n', "");
export const LEGACY_WORKFLOW_SOURCE = `name: Full Release Validation
on:
  workflow_dispatch:
    inputs:
      expected_sha:
        required: false
`;

export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

type DispatchRepositoryOptions = {
  candidateOwned?: boolean;
  releaseRef?: string;
  workflowSource?: string;
  targetSource?: Record<string, string>;
  targetAlreadyRemote?: boolean;
};
const repositoryTemplateDirs = useAutoCleanupTempDirTracker(afterAll);
const dispatchRepositoryTemplates = new Map<string, ReturnType<typeof createDispatchRepository>>();

function createDispatchRepository(root: string, options: DispatchRepositoryOptions = {}) {
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  mkdirSync(checkout);
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: checkout, stdio: "ignore" });
  runGit(checkout, ["config", "user.email", "release-test@openclaw.invalid"]);
  runGit(checkout, ["config", "user.name", "OpenClaw Release Test"]);
  mkdirSync(join(checkout, ".github", "workflows"), { recursive: true });
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  // Historical diagnostics intentionally exercise pre-bundled-AI, root-only sources.
  // Current candidate qualification below uses the complete two-package source set.
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.7.9"}\n');
  writeFileSync(
    join(checkout, "CHANGELOG.md"),
    "## 2026.8.1\n\nRelease notes for the complete selected candidate and its user-facing fixes.\n",
  );
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    LEGACY_WORKFLOW_SOURCE,
  );
  writeFileSync(
    join(checkout, "scripts", "release-ci-summary.mjs"),
    `import { existsSync, readFileSync } from "node:fs";
// Admission that advanced P with main verifies against the advanced P.
const advanced = process.env.MOCK_ADVANCED_P_PATH && existsSync(process.env.MOCK_ADVANCED_P_PATH)
  ? readFileSync(process.env.MOCK_ADVANCED_P_PATH, "utf8").trim().split("\\n").at(-1)
  : "";
const verifierSha = advanced || process.env.MOCK_VERIFIER_SHA || process.env.MOCK_WORKFLOW_SHA;
const expected = [
  "--validate-run", "123",
	  "--trusted-workflow-ref", process.env.MOCK_TRUSTED_WORKFLOW_REF,
  "--trusted-workflow-full-ref", process.env.MOCK_TRUSTED_WORKFLOW_FULL_REF,
  "--trusted-workflow-sha", verifierSha,
	  "--json",
  "--verifier-source-sha", verifierSha,
  "--verifier-source-file", process.argv[1],
];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected verifier args: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}
console.log(JSON.stringify({ valid: true, current: { runId: "123" }, root: { runId: "123" }, evidenceReuse: false }));
`,
  );
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: legacy workflow"]);
  const oldWorkflowSha = runGit(checkout, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(checkout, ".github", "workflows", "full-release-validation.yml"),
    options.workflowSource ?? CURRENT_WORKFLOW_SOURCE,
  );
  writeFileSync(join(checkout, "package.json"), '{"version":"2026.8.1"}\n');
  if (options.candidateOwned) {
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.8.1",
        dependencies: { "@openclaw/ai": "workspace:*" },
      }) + "\n",
    );
    mkdirSync(join(checkout, "packages/ai"), { recursive: true });
    writeFileSync(
      join(checkout, "packages/ai/package.json"),
      JSON.stringify({ name: "@openclaw/ai", version: "2026.8.1", dependencies: {} }) + "\n",
    );
    writeFileSync(
      join(checkout, ".github/workflows/openclaw-release-prepare.yml"),
      readFileSync(".github/workflows/openclaw-release-prepare.yml"),
    );
    mkdirSync(join(checkout, "scripts/lib"), { recursive: true });
    writeFileSync(
      join(checkout, "scripts/lib/release-qualification-coverage.json"),
      readFileSync("scripts/lib/release-qualification-coverage.json"),
    );
    writeFileSync(
      join(checkout, "scripts/lib/upgrade-survivor-scenarios.json"),
      readFileSync("scripts/lib/upgrade-survivor-scenarios.json"),
    );
  }
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: trusted workflow contract"]);
  const workflowSha = runGit(checkout, ["rev-parse", "HEAD"]);
  const trustedWorkflowTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
  runGit(checkout, ["remote", "add", "origin", origin]);
  runGit(checkout, ["push", "-u", "origin", "main"]);
  runGit(checkout, ["tag", trustedWorkflowTag, workflowSha]);
  runGit(checkout, ["push", "origin", `refs/tags/${trustedWorkflowTag}`]);
  runGit(checkout, ["checkout", "-b", releaseRef]);
  writeFileSync(join(checkout, "target.txt"), "release target\n");
  for (const [relativePath, content] of Object.entries(options.targetSource ?? {})) {
    mkdirSync(join(checkout, relativePath, ".."), { recursive: true });
    writeFileSync(join(checkout, relativePath), content);
  }
  runGit(checkout, ["add", "."]);
  runGit(checkout, ["commit", "-m", "test: release target"]);
  const targetSha = runGit(checkout, ["rev-parse", "HEAD"]);
  if (options.targetAlreadyRemote !== false) {
    runGit(checkout, ["push", "-u", "origin", releaseRef]);
  }
  runGit(checkout, ["checkout", "main"]);

  return { origin, checkout, oldWorkflowSha, workflowSha, trustedWorkflowTag, targetSha };
}

export function prepareDispatchRepository(root: string, options: DispatchRepositoryOptions) {
  const key = JSON.stringify([
    options.releaseRef ?? "release/2026.8.1",
    options.workflowSource ?? CURRENT_WORKFLOW_SOURCE,
    options.targetSource ?? {},
    options.targetAlreadyRemote !== false,
    options.candidateOwned === true,
  ]);
  let template = dispatchRepositoryTemplates.get(key);
  if (!template) {
    template = createDispatchRepository(
      repositoryTemplateDirs.make("openclaw-release-dispatch-template-"),
      options,
    );
    // Copy packed immutable history, while every case retains its own object store.
    runGit(template.origin, ["repack", "-ad"]);
    runGit(template.checkout, ["repack", "-ad"]);
    dispatchRepositoryTemplates.set(key, template);
  }
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  // Each case can change refs, config and objects without touching the prepared history.
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  cpSync(template.origin, origin, copyOptions);
  cpSync(template.checkout, checkout, copyOptions);
  runGit(checkout, ["remote", "set-url", "origin", origin]);
  return { ...template, origin, checkout };
}
