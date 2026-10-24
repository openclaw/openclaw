import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createNestedGitEnv, writeJsonFile } from "../helpers/temp-repo.js";
import { fixtureGit } from "./release-publish.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const parentEnv = {
  GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
  PARENT_WORKFLOW_SHA: "a".repeat(40),
};
function files(root: string) {
  return {
    read: (name: string) => fs.readFileSync(join(root, name), "utf8"),
    write(this: void, name: string, content: string) {
      const path = join(root, name);
      fs.writeFileSync(path, content);
      return path;
    },
    json: (name: string, content: unknown) => writeJsonFile(join(root, name), content),
  };
}
function runBash(root: string, script: string, env: NodeJS.ProcessEnv, shell = "bash") {
  return spawnSync(shell, ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, RUNNER_TEMP: root, ...parentEnv },
  });
}
const workflow = parse(fs.readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
const frozenNotes = (version: string) => `## ${version}\n\n### Fixes\n\n- Frozen release fix.`;

function publicationFixture(releaseVersion = "2026.9.4") {
  const root = fs.realpathSync(createTempDir("release-publish-historical-tooling-"));
  const io = files(root);
  const repository = resolve(".");
  fs.mkdirSync(join(root, "scripts"));
  io.write("scripts/render-github-release-notes.mts", 'throw Error("frozen target");\n');
  io.write("CHANGELOG.md", "# Changelog\n\n" + frozenNotes(releaseVersion) + "\n");
  const git = fixtureGit(root, "OpenClaw Test", "test@openclaw.invalid");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "historical release");
  const targetSha = git("rev-parse", "HEAD");
  io.write("CHANGELOG.md", "Working tree content must not be published.\n");
  fs.mkdirSync(join(root, ".release-harness/scripts"), { recursive: true });
  io.json(".release-harness/package.json", { version: "2026.9.5" });
  fs.copyFileSync(
    join(repository, "scripts/render-github-release-notes.mts"),
    join(root, ".release-harness/scripts/render-github-release-notes.mts"),
  );
  // Keep the CLI entry at its invoked path; support modules can use the current checkout.
  for (const source of [
    "scripts/lib",
    "scripts/tsx.mjs",
    "scripts/openclaw-npm-extended-stable-release.mjs",
    "scripts/full-release-validation-policy.mjs",
  ]) {
    fs.symlinkSync(join(repository, source), join(root, ".release-harness", source));
  }
  // Publication installs tooling in the harness, then links the frozen target cwd to it.
  fs.symlinkSync(
    join(repository, "node_modules"),
    join(root, ".release-harness/node_modules"),
    "dir",
  );
  fs.symlinkSync(".release-harness/node_modules", join(root, "node_modules"), "dir");
  const env = {
    ...createNestedGitEnv(),
    GITHUB_WORKSPACE: root,
    GITHUB_REPOSITORY: "fixture/repository",
    RELEASE_TAG: `v${releaseVersion}`,
    TARGET_SHA: targetSha,
  };
  return {
    root,
    targetSha,
    ...io,
    run: (script: string, overrides: NodeJS.ProcessEnv = {}, shell = "bash") =>
      runBash(root, script, { ...env, ...overrides }, shell),
  };
}

it.each([true, false])("renders pinned release notes with manifest=%s", (hasManifest) => {
  const { root, targetSha, read, write, json, run } = publicationFixture();
  const prepare = workflow.jobs.publish.steps.find(
    (step: { name?: string }) => step.name === "Prepare GitHub release notes",
  );
  const notes = join(root, "helper-notes.md");
  const proof = write("proof.md", `### Release verification\n\n- Source: ${targetSha}\n`);
  if (hasManifest) {
    json("full-release-validation-manifest.json", {
      childRuns: {},
      childEvidence: {},
      advisoryJobs: [],
    });
  }
  expect(
    new Set(
      workflow.jobs.publish.steps.flatMap((step: { env?: Record<string, string> }) =>
        step.env?.FULL_RELEASE_VALIDATION_MANIFEST_DIR
          ? [step.env.FULL_RELEASE_VALIDATION_MANIFEST_DIR]
          : [],
      ),
    ),
  ).toEqual(new Set(["${{ runner.temp }}/full-release-validation-manifest"]));
  const result = run(
    `
set -euo pipefail
${prepare.run}
source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"
render_github_release_notes "$NOTES_FILE" "$PROOF_FILE"
canonical_release_body_matches "$NOTES_FILE"
`,
    {
      NOTES_FILE: notes,
      PROOF_FILE: proof,
      RELEASE_EVIDENCE_MODE: "full-release-validation",
      ...(hasManifest ? { FULL_RELEASE_VALIDATION_MANIFEST_DIR: root } : {}),
    },
    process.platform === "darwin" ? "/bin/bash" : "bash",
  );
  expect(result.status, result.stderr).toBe(0);
  const prepared = read("release-notes.md");
  expect(prepared).toContain("Frozen release fix.");
  expect(read("helper-notes.md")).toBe(`${prepared}\n\n${read("proof.md").trimEnd()}`);
});

it.each<[string, string, string?, string?]>([
  ["draft", "latest", "edit"],
  ["missing", "latest", "create"],
  ["public", "latest"],
  ["diverged-public", "latest"],
  ["docs", "latest", undefined, "create_or_update_github_release"],
  ["docs", "latest", undefined, "append_release_proof_to_github_release"],
])(
  "prepares %s release on %s without promoting a draft",
  (existing, distTag, command, operation = "create_or_update_github_release") => {
    const docsOwned = existing === "docs";
    const root = createTempDir("release-publish-draft-");
    const commands = join(root, "command");
    const notes = join(root, "notes.md");
    fs.writeFileSync(notes, "Canonical release notes\n");
    const result = runBash(
      root,
      `
source "$OWNER_SCRIPT"
verify_release_tag_target() { :; }
canonical_release_body_matches() { [[ "$EXISTING" != diverged-public ]]; }
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    [[ "$EXISTING" != missing ]] || return 1
    printf '{"isDraft":%s,"body":"%s"}\\n' "$([[ "$EXISTING" == draft ]] && echo true || echo false)" "$RELEASE_BODY"
    return
  fi
  printf '%s\\n' "$@" > "$COMMAND_FILE"
  if [[ "$2" == edit && "$EXISTING" == draft && " $* " == *" --latest "* ]]; then
    echo 'HTTP 422: Latest release cannot be draft or prerelease.' >&2
    return 1
  fi
}
prepared_release_notes_file="$NOTES_FILE"
"$OPERATION"
`,
      {
        ...(docsOwned ? process.env : { PATH: process.env.PATH }),
        OWNER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
        EXISTING: existing,
        OPERATION: operation,
        RELEASE_BODY: docsOwned ? "<!-- openclaw-release-publication:docs-v1 -->" : "canonical",
        COMMAND_FILE: commands,
        NOTES_FILE: notes,
        GITHUB_STEP_SUMMARY: join(root, "summary"),
        GITHUB_REPOSITORY: "fixture/repository",
        RELEASE_TAG: docsOwned ? "v2026.9.4" : "v2026.9.2",
        RELEASE_NPM_DIST_TAG: distTag,
      },
    );
    expect(result.status, result.stderr).toBe(existing === "diverged-public" || docsOwned ? 1 : 0);
    if (docsOwned) {
      expect(result.stderr).toContain("Release body belongs to post-docs publication");
    }
    if (!command) {
      expect(fs.existsSync(commands)).toBe(false);
      return;
    }
    const args = fs.readFileSync(commands, "utf8").trim().split("\n");
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

it.each([
  { state: "missing", body: "canonical", error: undefined },
  { state: "matching", body: "proof", error: undefined },
  { state: "different", body: "canonical", error: "differs from this release run" },
  { state: "missing", body: "different", error: "Public release notes are no longer canonical" },
  { state: "missing", body: "wrong-sha", error: "does not match" },
])("resumes a public release with $state evidence and $body notes", ({ state, body, error }) => {
  const { root, targetSha, read, write, json, run } = publicationFixture();
  const notes = frozenNotes("2026.9.4");
  const releaseBody =
    body === "different"
      ? "Unrelated release notes"
      : body === "proof" || body === "wrong-sha"
        ? `${notes}\n\n### Release verification\n\n- release SHA: \`${body === "wrong-sha" ? "b".repeat(40) : targetSha}\``
        : notes;
  const assetName = "openclaw-2026.9.4-release-manifest.json";
  json("release.json", {
    isDraft: false,
    body: releaseBody,
    assets: state === "missing" ? [] : [{ name: assetName }],
    url: "https://github.com/fixture/repository/releases/tag/v2026.9.4",
  });
  write("manifest.json", '{"source":"frozen"}');
  write("full-release-validation-manifest.json", "{}");
  write("existing.json", state === "different" ? '{"source":"changed"}' : '{"source":"frozen"}');
  const result = run(
    `
source "$GITHUB_WORKSPACE/.release-harness/scripts/lib/release-publish-children.sh"
verify_release_tag_target() { :; }
gh() {
  case "$1 $2" in
    "release view") cat "$RUNNER_TEMP/release.json" ;;
    "release download")
      local destination=""
      while (( $# > 0 )); do
        if [[ "$1" == --dir ]]; then destination="$2"; break; fi
        shift
      done
      cp "$RUNNER_TEMP/existing.json" "$destination/$ASSET_NAME"
      ;;
    "release upload") printf '%s\\n' "$@" >> "$RUNNER_TEMP/uploads" ;;
    *) echo "Unexpected mutation: $*" >&2; return 1 ;;
  esac
}
prepared_release_notes_file="$RUNNER_TEMP/prepared.md"
render_github_release_notes "$prepared_release_notes_file"
guard_existing_public_release
create_or_update_github_release
attach_or_verify_release_asset "$RUNNER_TEMP/manifest.json" "$ASSET_NAME"
`,
    {
      GITHUB_STEP_SUMMARY: join(root, "summary"),
      PUBLISH_OPENCLAW_NPM: "true",
      RELEASE_NPM_DIST_TAG: "latest",
      RELEASE_EVIDENCE_MODE: "full-release-validation",
      FULL_RELEASE_VALIDATION_MANIFEST_DIR: root,
      ASSET_NAME: assetName,
    },
  );
  expect(result.status, result.stderr).toBe(error ? 1 : 0);
  if (error) {
    expect(result.stderr).toContain(error);
  }
  expect(fs.existsSync(join(root, "uploads"))).toBe(state === "missing" && !error);
  expect(JSON.parse(read("release.json")).body).toBe(releaseBody);
});
