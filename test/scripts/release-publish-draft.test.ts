import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("renders and verifies an old pinned target using trusted publication tooling", () => {
  const root = realpathSync(createTempDir("release-publish-historical-tooling-"));
  const repository = resolve(".");
  mkdirSync(join(root, "scripts"));
  writeFileSync(
    join(root, "scripts/render-github-release-notes.mts"),
    'throw new Error("frozen target renderer must not execute");\n',
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## 2026.9.4\n\n### Fixes\n\n- Frozen release fix.\n",
  );
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: createNestedGitEnv(),
    }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=test@openclaw.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "historical release",
  ]);
  const targetSha = git(["rev-parse", "HEAD"]);
  writeFileSync(join(root, "CHANGELOG.md"), "Working tree content must not be published.\n");
  mkdirSync(join(root, ".release-harness/scripts/lib"), { recursive: true });
  for (const source of [
    "scripts/render-github-release-notes.mts",
    "scripts/lib/release-changelog.mjs",
    "scripts/lib/release-notes-compaction.mjs",
    "scripts/lib/release-publish-children.sh",
  ]) {
    copyFileSync(join(repository, source), join(root, ".release-harness", source));
  }
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const workflow = parse(
    readFileSync(join(repository, ".github/workflows/openclaw-release-publish.yml"), "utf8"),
  );
  const prepare = workflow.jobs.publish.steps.find(
    (step: { name?: string }) => step.name === "Prepare GitHub release notes",
  );
  const notes = join(root, "helper-notes.md");
  const proof = join(root, "proof.md");
  writeFileSync(proof, `### Release verification\n\n- Source: ${targetSha}\n`);
  const result = spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      `
set -euo pipefail
${prepare.run}
source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"
render_github_release_notes "$NOTES_FILE" "$PROOF_FILE"
canonical_release_body_matches "$NOTES_FILE"
`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...createNestedGitEnv(),
        GITHUB_WORKSPACE: root,
        RUNNER_TEMP: root,
        GITHUB_REPOSITORY: "fixture/repository",
        RELEASE_TAG: "v2026.9.4",
        TARGET_SHA: targetSha,
        GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
        PARENT_WORKFLOW_SHA: "a".repeat(40),
        NOTES_FILE: notes,
        PROOF_FILE: proof,
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const prepared = readFileSync(join(root, "release-notes.md"), "utf8");
  const verified = readFileSync(notes, "utf8");
  expect(prepared).toContain("Frozen release fix.");
  expect(verified).toBe(`${prepared}\n\n${readFileSync(proof, "utf8").trimEnd()}`);
});

it.each([
  { existing: "draft", distTag: "latest", command: "edit" },
  { existing: "draft", distTag: "beta", command: "edit" },
  { existing: "missing", distTag: "latest", command: "create" },
  { existing: "public", distTag: "latest", command: undefined },
])(
  "prepares $existing release on $distTag without promoting a draft",
  ({ existing, distTag, command }) => {
    const root = createTempDir("release-publish-draft-");
    const commands = join(root, "command");
    const notes = join(root, "notes.md");
    writeFileSync(notes, "Canonical release notes\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$OWNER_SCRIPT"
verify_release_tag_target() { :; }
canonical_release_body_matches() { :; }
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    [[ "$EXISTING" != missing ]] || return 1
    printf '{"isDraft":%s,"body":"canonical"}\\n' "$([[ "$EXISTING" == draft ]] && echo true || echo false)"
    return
  fi
  printf '%s\\n' "$@" > "$COMMAND_FILE"
  if [[ "$2" == edit && "$EXISTING" == draft && " $* " == *" --latest "* ]]; then
    echo 'HTTP 422: Latest release cannot be draft or prerelease.' >&2
    return 1
  fi
}
prepared_release_notes_file="$NOTES_FILE"
create_or_update_github_release
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          OWNER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          EXISTING: existing,
          COMMAND_FILE: commands,
          NOTES_FILE: notes,
          RUNNER_TEMP: root,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "fixture/repository",
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
          PARENT_WORKFLOW_SHA: "a".repeat(40),
          RELEASE_TAG: "v2026.9.2",
          RELEASE_NPM_DIST_TAG: distTag,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    if (!command) {
      expect(existsSync(commands)).toBe(false);
      return;
    }
    const args = readFileSync(commands, "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["release", command, "v2026.9.2"]);
    expect(args).toContain(notes);
    expect(args).not.toContain("--draft=false");
    if (command === "edit") {
      expect(args.some((arg) => arg.startsWith("--latest"))).toBe(false);
    } else {
      expect(args).toContain("--draft");
      expect(args).toContain("--latest");
    }
  },
);

it.each(["create_or_update_github_release", "append_release_proof_to_github_release"])(
  "%s refuses a docs-publication release body",
  (operation) => {
    const root = createTempDir("release-publish-docs-stage-");
    const commands = join(root, "commands");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$OWNER_SCRIPT"
verify_release_tag_target() { :; }
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    printf '%s' '{"isDraft":false,"body":"<!-- openclaw-release-publication:docs-v1 -->"}'
    return
  fi
  printf '%s\\n' "$@" > "$COMMAND_FILE"
}
"$OPERATION"
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          OWNER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          COMMAND_FILE: commands,
          RELEASE_TAG: "v2026.9.4",
          RELEASE_NPM_DIST_TAG: "latest",
          GITHUB_REPOSITORY: "fixture/repository",
          RUNNER_TEMP: root,
          OPERATION: operation,
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
          PARENT_WORKFLOW_SHA: "a".repeat(40),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release body belongs to post-docs publication");
    expect(existsSync(commands)).toBe(false);
  },
);
