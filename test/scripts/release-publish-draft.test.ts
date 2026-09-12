import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function releaseNotesFixture() {
  const root = createTempDir("release-publish-notes-");
  const tooling = join(root, ".release-harness");
  const sourceSha = "a".repeat(40);
  const releaseTag = "v2026.9.2";
  const previousBody = "## 2026.9.2\n\n- Candidate changelog notes.";
  const proof = `### Release verification\n\n- release SHA: \`${sourceSha}\``;
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  mkdirSync(join(tooling, "scripts/lib"), { recursive: true });
  for (const file of [
    "scripts/render-github-release-notes.mts",
    "scripts/lib/release-notes-compaction.mjs",
    "scripts/lib/release-version.mjs",
  ]) {
    copyFileSync(resolve(file), join(tooling, file));
    writeFileSync(join(root, file), 'throw new Error("selected tag tooling executed");\n');
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "CHANGELOG.md"), "Wrong working-copy changelog.\n");
  writeFileSync(join(tooling, "CHANGELOG.md"), "Wrong tooling changelog.\n");
  const changelog = join(root, "target-changelog.md");
  writeFileSync(changelog, `# Changelog\n\n${previousBody}\n`);
  const notes = join(root, "notes.md");
  const metadata = join(root, "metadata.json");
  const proofFile = join(root, "proof.md");
  writeFileSync(proofFile, proof);
  const releaseState = join(root, "release.json");
  const mutationLog = join(root, "mutations");
  const run = (command: string) =>
    spawnSync(
      "bash",
      [
        "-c",
        `
source "$OWNER_SCRIPT"
git() {
  [[ "$#" == 2 && "$1" == show && "$2" == "$TARGET_SHA:CHANGELOG.md" ]] || return 1
  cat "$TARGET_CHANGELOG"
}
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    cat "$RELEASE_STATE"
    return
  fi
  printf '%s\\n' "$@" >> "$MUTATION_LOG"
}
${command}
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          OWNER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          GITHUB_WORKSPACE: root,
          RUNNER_TEMP: root,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "fixture/repository",
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
          PARENT_WORKFLOW_SHA: "b".repeat(40),
          TARGET_SHA: sourceSha,
          TARGET_CHANGELOG: changelog,
          RELEASE_TAG: releaseTag,
          RELEASE_NPM_DIST_TAG: "latest",
          PUBLISH_OPENCLAW_NPM: "true",
          NOTES_FILE: notes,
          METADATA_FILE: metadata,
          PROOF_FILE: proofFile,
          RELEASE_STATE: releaseState,
          MUTATION_LOG: mutationLog,
        },
      },
    );
  return {
    root,
    tooling,
    changelog,
    notes,
    metadata,
    previousBody,
    proof,
    mutationLog,
    run,
    publicBody(body: string, withEvidence = true) {
      writeFileSync(notes, body);
      writeFileSync(
        releaseState,
        JSON.stringify({
          isDraft: false,
          body,
          assets: withEvidence
            ? [{ name: `openclaw-${releaseTag.slice(1)}-dependency-evidence.zip` }]
            : [],
          url: `https://github.com/fixture/repository/releases/tag/${releaseTag}`,
        }),
      );
    },
  };
}

it("uses the trusted renderer closure and TARGET_SHA changelog for generation and verification", () => {
  const fixture = releaseNotesFixture();
  const result = fixture.run(`
render_github_release_notes "$NOTES_FILE" "$PROOF_FILE" "$METADATA_FILE"
canonical_release_body_matches "$NOTES_FILE"
`);

  expect(result.status, result.stderr).toBe(0);
  const body = readFileSync(fixture.notes, "utf8");
  expect(body).toContain(fixture.previousBody);
  expect(body).toContain(
    "[latest published Linux companion](https://github.com/fixture/repository/releases/tag/linux-stable)",
  );
  expect(body).toContain(fixture.proof);
  expect(JSON.parse(readFileSync(fixture.metadata, "utf8"))).toMatchObject({
    mode: "full",
    verificationIncluded: true,
  });
  fixture.publicBody(body);
  const resumed = fixture.run(`
guard_existing_public_release
verify_release_tag_target() { :; }
prepared_release_notes_file="$NOTES_FILE"
create_or_update_github_release
`);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stderr).not.toContain("previous canonical body");
  expect(existsSync(fixture.mutationLog)).toBe(false);
});

it.each(["with-proof", "compact-with-proof", "at-body-limit"])(
  "resumes a previous canonical public body %s without stripping evidence before proof append",
  (kind) => {
    const fixture = releaseNotesFixture();
    let previousBody = `${fixture.previousBody}\n\n${fixture.proof}`;
    if (kind !== "with-proof") {
      const prefix = `${fixture.previousBody}\n\n### Complete contribution record\n\n`;
      const section =
        prefix + "x".repeat(kind === "at-body-limit" ? 125_000 - prefix.length : 130_000);
      writeFileSync(fixture.changelog, section);
      previousBody =
        kind === "at-body-limit"
          ? section
          : `${prefix}The full contribution record is available in the tag-pinned [CHANGELOG.md](https://github.com/fixture/repository/blob/v2026.9.2/CHANGELOG.md#complete-contribution-record).\n\n${fixture.proof}`;
    }
    fixture.publicBody(previousBody);
    const result = fixture.run(`
if canonical_release_body_matches "$NOTES_FILE"; then
  echo "Strict verification accepted the previous body" >&2
  exit 99
fi
guard_existing_public_release
verify_release_tag_target() { :; }
prepared_release_notes_file="$NOTES_FILE"
create_or_update_github_release
render_github_release_notes "$NOTES_FILE" "$PROOF_FILE" "$METADATA_FILE"
canonical_release_body_matches "$NOTES_FILE"
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Release body does not match canonical release notes.");
    expect(result.stderr).toContain("previous canonical body; Linux link pending proof append");
    expect(existsSync(fixture.mutationLog)).toBe(false);
    const migrated = readFileSync(fixture.notes, "utf8");
    expect(migrated).toContain("/releases/tag/linux-stable");
    expect(migrated).toContain(fixture.proof);
    if (kind !== "with-proof") {
      expect(JSON.parse(readFileSync(fixture.metadata, "utf8"))).toMatchObject({
        mode: "compact",
        verificationIncluded: true,
      });
    }
  },
);

it.each(["divergent", "wrong-linux-link", "wrong-proof-sha", "missing-evidence"])(
  "rejects %s previous public notes before any mutation",
  (kind) => {
    const fixture = releaseNotesFixture();
    const proof =
      kind === "wrong-proof-sha"
        ? fixture.proof.replaceAll("a".repeat(40), "c".repeat(40))
        : fixture.proof;
    let notes =
      kind === "divergent"
        ? fixture.previousBody.replace("Candidate changelog notes.", "Unrelated release notes.")
        : fixture.previousBody;
    if (kind === "wrong-linux-link") {
      notes +=
        "\n\n### Linux companion\n\nDownload the [latest published Linux companion](https://github.com/fixture/repository/releases/tag/unrelated).";
    }
    fixture.publicBody(`${notes}\n\n${proof}`, kind !== "missing-evidence");
    const result = fixture.run(`
canonical_status=0
canonical_release_body_matches "$NOTES_FILE" true || canonical_status=$?
printf 'canonical-status=%s\\n' "$canonical_status"
guard_existing_public_release
`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `canonical-status=${kind === "divergent" || kind === "wrong-linux-link" ? 1 : 0}`,
    );
    expect(result.stderr).toContain("without complete postpublish evidence");
    expect(result.stderr).not.toContain("selected tag tooling executed");
    expect(result.stderr).not.toContain("does not provide an export");
    if (kind === "wrong-proof-sha" || kind === "missing-evidence") {
      expect(result.stderr).toContain("previous canonical body; Linux link pending proof append");
      expect(result.stderr).not.toContain("Release body does not match canonical release notes.");
    } else {
      expect(result.stderr).toContain("Release body does not match canonical release notes.");
    }
    expect(existsSync(fixture.mutationLog)).toBe(false);
  },
);

it("refuses public body drift after the resume guard instead of overwriting it", () => {
  const fixture = releaseNotesFixture();
  fixture.publicBody(`${fixture.previousBody}\n\n${fixture.proof}`);
  const result = fixture.run(`
guard_existing_public_release
jq '.body |= sub("Candidate changelog notes."; "Unrelated release notes.")' "$RELEASE_STATE" > "$RUNNER_TEMP/changed-release.json"
mv "$RUNNER_TEMP/changed-release.json" "$RELEASE_STATE"
verify_release_tag_target() { :; }
prepared_release_notes_file="$NOTES_FILE"
create_or_update_github_release
`);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("previous canonical body; Linux link pending proof append");
  expect(result.stderr).toContain("Public release notes are no longer canonical");
  expect(existsSync(fixture.mutationLog)).toBe(false);
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
