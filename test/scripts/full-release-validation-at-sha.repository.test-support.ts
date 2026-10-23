import { execFileSync } from "node:child_process";
import { constants as fsConstants, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

export const SCRIPT_PATH = resolve("scripts/full-release-validation-at-sha.mjs");
export const testNodeExecPath = resolveTestNodeExecPath();
const workflowPath = ".github/workflows/full-release-validation.yml";
export const CURRENT_WORKFLOW_SOURCE = readFileSync(workflowPath, "utf8");
export const CONTRACT_ONE_WORKFLOW_SOURCE = CURRENT_WORKFLOW_SOURCE.replace(
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "2"',
  'RELEASE_ISOLATION_TOOLING_CONTRACT: "1"',
).replace('  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n', "");
export const LEGACY_WORKFLOW_SOURCE = `name: Full Release Validation
on: {workflow_dispatch: {inputs: {expected_sha: {required: false}}}}
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
  // Records a PR-branch head that the release branch only received as a squash.
  unreachableContributionRecord?: boolean;
  // Replaces the candidate-owned release-notes prose line.
  releaseNotes?: string;
};
const repositoryTemplateDirs = useAutoCleanupTempDirTracker(afterAll);
const dispatchRepositoryTemplates = new Map<string, ReturnType<typeof createDispatchRepository>>();

function createDispatchRepository(root: string, options: DispatchRepositoryOptions = {}) {
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const releaseRef = options.releaseRef ?? "release/2026.8.1";
  const write = (path: string, content: string | Buffer) => {
    const destination = join(checkout, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const writePackage = (path: string, name: string, dependencies: Record<string, string>) =>
    write(path, JSON.stringify({ name, version: "2026.8.1", dependencies }) + "\n");
  const commit = (message: string) => {
    runGit(checkout, ["add", "."]);
    runGit(checkout, ["commit", "-m", message]);
    return runGit(checkout, ["rev-parse", "HEAD"]);
  };
  mkdirSync(checkout);
  execFileSync("git", ["init", "--bare", origin], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: checkout, stdio: "ignore" });
  runGit(checkout, ["config", "user.email", "release-test@openclaw.invalid"]);
  runGit(checkout, ["config", "user.name", "OpenClaw Release Test"]);
  // Historical diagnostics use root-only sources; candidate qualification includes AI.
  write("package.json", '{"version":"2026.7.9"}\n');
  write("CHANGELOG.md", "## 2026.8.1\n\nRelease notes for the selected candidate.\n");
  write(workflowPath, LEGACY_WORKFLOW_SOURCE);
  write(
    "scripts/release-ci-summary.mjs",
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
  const oldWorkflowSha = commit("test: legacy workflow");
  write(workflowPath, options.workflowSource ?? CURRENT_WORKFLOW_SOURCE);
  write("package.json", '{"version":"2026.8.1"}\n');
  if (options.candidateOwned) {
    writePackage("package.json", "openclaw", { "@openclaw/ai": "workspace:*" });
    writePackage("packages/ai/package.json", "@openclaw/ai", {});
    for (const path of [
      ".github/workflows/openclaw-release-prepare.yml",
      "scripts/lib/release-qualification-coverage.json",
      "scripts/lib/upgrade-survivor-scenarios.json",
    ]) {
      write(path, readFileSync(path));
    }
  }
  const workflowSha = commit("test: trusted workflow contract");
  const trustedWorkflowTag = `release-publish/${workflowSha.slice(0, 12)}-123`;
  runGit(checkout, ["remote", "add", "origin", origin]);
  runGit(checkout, ["push", "-u", "origin", "main"]);
  runGit(checkout, ["tag", trustedWorkflowTag, workflowSha]);
  runGit(checkout, ["push", "origin", `refs/tags/${trustedWorkflowTag}`]);
  let recordTarget = workflowSha;
  if (options.unreachableContributionRecord) {
    runGit(checkout, ["checkout", "-b", "pr-head"]);
    write("squashed.txt", "pre-squash pull request head\n");
    recordTarget = commit("test: pull request head");
    runGit(checkout, ["checkout", "main"]);
  }
  runGit(checkout, ["checkout", "-b", releaseRef]);
  write("target.txt", "release target\n");
  if (options.unreachableContributionRecord) {
    write("squashed.txt", "pre-squash pull request head\n");
  }
  if (options.candidateOwned) {
    write(
      "CHANGELOG.md",
      [
        "## 2026.8.1",
        "",
        options.releaseNotes ?? "Release notes for the selected candidate.",
        "",
        "### Complete contribution record",
        "",
        `This audited record covers the complete ${oldWorkflowSha}..${recordTarget} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
        "",
        "#### Pull requests",
        "",
        "- **PR #1** fix: example.",
        "",
      ].join("\n"),
    );
  }
  for (const [relativePath, content] of Object.entries(options.targetSource ?? {})) {
    write(relativePath, content);
  }
  const targetSha = commit("test: release target");
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
    options.unreachableContributionRecord === true,
    options.releaseNotes ?? null,
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
