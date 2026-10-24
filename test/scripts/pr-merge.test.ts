import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createFixtureGit } from "./pr-merge-fixture-git.test-support.js";
import { createIndependentPrFixtureEnv } from "./pr-wrapper.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const credit = (name: string, email = `${name.toLowerCase()}@example.com`) =>
  `Co-authored-by: ${name} <${email}>`;
const human = credit("Contributor");
const machine = credit("Claude", "noreply@anthropic.com");
const refresh = credit("Refresh Author", "refresh@example.com");
const author = (name = "Contributor", email = `${name.toLowerCase()}@example.com`) => ({
  name,
  email,
  changesTree: true,
  user: { login: name.toLowerCase(), type: "User" },
});
type Author = Omit<ReturnType<typeof author>, "user"> & {
  user: { login: string; type: string } | null;
};
type Input = {
  preview: string;
  source: string;
  authors: Author[];
  prAuthor?: { login: string; __typename: string };
  captured: string;
  queue: boolean;
  sourceCredit?: boolean;
  squashDefault?: { title: string; message: string; commits: string[] };
};
type Scenario = Partial<Input> & { body?: string };
const squash = (title: string, message: string, ...commits: string[]): Scenario => ({
  squashDefault: { title, message, commits },
});
function compose({ body, ...input }: Scenario = {}, env = createIndependentPrFixtureEnv()) {
  return spawnSync(process.execPath, ["scripts/pr-lib/merge-body.mjs", "compose"], {
    encoding: "utf8",
    env,
    input: JSON.stringify({
      preview: "Repair",
      source: "",
      authors: [],
      queue: false,
      captured:
        body === undefined ? "" : JSON.stringify({ base64: Buffer.from(body).toString("base64") }),
      ...input,
    }),
  });
}

describePosix("squash body owner", () => {
  it.each<[string, Scenario, string]>([
    [
      "one commit description",
      squash("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES", "Title\n\nDescription"),
      "Description\n",
    ],
    [
      "commit bullets",
      squash("PR_TITLE", "COMMIT_MESSAGES", "First\n\nDetail", "Second"),
      "* First\n\nDetail\n\n* Second\n",
    ],
    [
      "multiple commits with automatic title",
      squash("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES", "First", "Second"),
      "* First\n\n* Second\n",
    ],
    ["blank default", squash("PR_TITLE", "BLANK"), "\n"],
    ["PR body default", squash("PR_TITLE", "PR_BODY"), "Repair\n"],
    [
      "reviewed body overrides defaults",
      { ...squash("PR_TITLE", "COMMIT_MESSAGES", "First", "Second"), body: "Reviewed bytes" },
      "Reviewed bytes",
    ],
    ["empty preview", { preview: "", source: human }, human + "\n"],
    ["plain preview", { source: human }, "Repair\n\n" + human + "\n"],
    ["existing trailer", { preview: human, source: human }, human + "\n"],
    ["trailing whitespace", { preview: human + "\n\n \t\n", source: human }, human + "\n"],
    [
      "divider prose",
      { preview: "Repair\n\n---\n\nMore context\n\n" + human, source: human },
      "Repair\n\n---\n\nMore context\n\n" + human + "\n",
    ],
    [
      "quoted trailer is prose",
      { preview: "Quoted example: " + human + "\n\nNot a trailer.", source: human },
      "Quoted example: " + human + "\n\nNot a trailer.\n\n" + human + "\n",
    ],
    [
      "source deduplication",
      { source: human + "\n" + human + "\n" + credit("Pair") },
      "Repair\n\n" + human + "\n" + credit("Pair") + "\n",
    ],
    ["explicit empty body", { body: "" }, ""],
    ["explicit UTF-8 and CRLF", { body: "é漢字\r\n\r\n" }, "é漢字\r\n\r\n"],
    [
      "explicit non-coauthor trailers",
      { body: "Description\n\nReviewed-by: Reviewer <reviewer@example.com>\n\n" },
      "Description\n\nReviewed-by: Reviewer <reviewer@example.com>\n\n",
    ],
    ["explicit credit deduplication", { body: human + "\n\n", source: human }, human + "\n\n"],
    [
      "explicit body without final newline",
      { body: "Corrected prose", source: human },
      "Corrected prose\n\n" + human,
    ],
    [
      "explicit body replaces closing prose but retains credit",
      {
        body: "Partial repair. Related: #42.\r\n\r\n" + credit("Operator") + "\r\n\r\n",
        preview: "Fixes #42\n\n" + credit("Server"),
        authors: [author("Server")],
        source: credit("Source"),
      },
      "Partial repair. Related: #42.\r\n\r\n" +
        credit("Operator") +
        "\n" +
        credit("Server") +
        "\n" +
        credit("Source") +
        "\r\n\r\n",
    ],
    ["queue without a required edit", { queue: true }, "Repair\n"],
  ])("%s", (_name, input, output) => {
    const result = compose(input);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(output);
  });

  it("preserves ordered linked REST authors but excludes bots and unlinked authors", () => {
    const result = compose({
      sourceCredit: true,
      authors: [
        author("First"),
        { ...author("Automation"), user: { login: "automation", type: "Bot" } },
        author("Second"),
        { ...author("Unlinked"), user: null },
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Repair\n\n" + credit("First") + "\n" + credit("Second") + "\n");
  });

  it.each([
    { kind: "empty-only", keep: false },
    { kind: "mixed", keep: true },
    { kind: "PR author", keep: true },
    { kind: "source trailer", keep: true },
  ])("handles tree-identical $kind credit", ({ kind, keep }) => {
    const result = compose({
      preview: "Repair\n\n" + refresh,
      authors: [
        {
          ...author("Refresh Author", "refresh@example.com"),
          changesTree: kind === "mixed",
          user: { login: "refresh-author", type: "User" },
        },
      ],
      prAuthor: {
        login: kind === "PR author" ? "refresh-author" : "contributor",
        __typename: "User",
      },
      source: kind === "source trailer" ? refresh : "",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(keep ? "Repair\n\n" + refresh + "\n" : "Repair\n");
  });

  it("omits a tree-identical REST source author", () => {
    const result = compose({ sourceCredit: true, authors: [{ ...author(), changesTree: false }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Repair\n");
  });

  it.each([
    { email: "contributor@example.com", keep: true },
    { email: "contributor@host.local", keep: false },
    { email: "contributor@users.noreply.github.com", keep: false },
  ])("limits unlinked PR-author credit: $email", ({ email, keep }) => {
    const line = credit("Contributor", email);
    const result = compose({
      preview: "Repair\n\n" + line,
      authors: [{ ...author("Contributor", email), user: null, changesTree: false }],
      prAuthor: { login: "contributor", __typename: "User" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(keep ? "Repair\n\n" + line + "\n" : "Repair\n");
  });

  it.each(["agent@host.LOCALHOST", "123+unknown@users.noreply.github.com", "unlinked@example.com"])(
    "drops unverified source and preview credit: %s",
    (email) => {
      const line = credit("Local Author", email);
      const result = compose({
        preview: "Repair\n\n" + line,
        source: line + "\n" + human,
        authors: [{ ...author("Local Author", email), user: null }],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("Repair\n\n" + human + "\n");
      expect(result.stderr.trim()).toBe(
        `Dropped squash co-author credit: ${JSON.stringify([line])}`,
      );
    },
  );

  it.each(["second@example.com", "123+second-author@users.noreply.github.com"])(
    "matches linked preview authors case-insensitively: %s",
    (email) => {
      const line = credit("Second Author", email);
      const result = compose({
        preview: "Repair\n\n" + line,
        authors: [author("Second Author", email.toUpperCase())],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("Repair\n\n" + line + "\n");
    },
  );

  it.each([
    { name: "Codex", email: "codex@openai.com" },
    { name: "roboclaw-bot", email: "309084314+roboclaw-bot@users.noreply.github.com" },
    { name: "RoboClaw", email: "services+roboclaw@openclaw.org" },
    { name: "clawsweeper", email: "274271284+clawsweeper[bot]@users.noreply.github.com" },
  ])(
    "omits machine author preview credit from a reviewed body while retaining human authors: %j",
    (machineAuthor) => {
      const result = compose({
        sourceCredit: true,
        authors: [author(), author(machineAuthor.name, machineAuthor.email)],
        preview: `Repair summary\n\n${credit(machineAuthor.name, machineAuthor.email)}\n${human}`,
        body: "Reviewed correction.\n",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`Reviewed correction.\n\n${human}\n`);
    },
  );

  it.each([
    machine,
    "co-authored-by: Claude <NOREPLY@ANTHROPIC.COM>",
    "Co-Authored-By: Claude\n <noreply@anthropic.com>",
    credit("Any App", "1274271284+clawsweeper[bot]@users.noreply.github.com"),
  ])("removes machine credit without rejecting lookalike humans: %s", (line) => {
    const humans = [
      credit("Claude"),
      credit("Human", "person@anthropic.com"),
      credit("Other", "noreply@anthropic.com.example.org"),
      credit("Human", "781889+Takhoffman@users.noreply.github.com"),
      credit("clawsweeper"),
      credit("Human", "274271284+human@users.noreply.github.com"),
      credit("Other", "274271284+clawsweeper[bot]@users.noreply.github.com.example.org"),
      credit("Copilot"),
      credit("Human", "1223556219+copilot@users.noreply.github.com"),
      credit("Other", "person[bot]@example.com"),
      credit("Other", "209825114+claude[bot]@users.noreply.github.com.example.org"),
      credit("Other", "274271284+clawsweeperbot@users.noreply.github.com"),
    ].join("\n");
    const result = compose({ preview: "Repair\n\n" + line, source: humans });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Repair\n\n" + humans + "\n");
  });

  it.each([
    [machine, ""],
    ["  " + machine, ""],
    ["Co-Authored-By: Claude\n <noreply@anthropic.com>", ""],
    [machine + "\n  indented note", "  indented note\n\n"],
  ])("removes replayed bullet credit %s without removing unrelated prose", (line, retained) => {
    const result = compose({
      preview: `* First\n\n${line}\n\n* Second\n\n---------\n\n${human}\n`,
      source: human,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`* First\n\n${retained}* Second\n\n---------\n\n${human}\n`);
  });

  it.each<[string, Scenario, string]>([
    [
      "ambiguous unsupported credit",
      { preview: refresh + "\n\nQuoted example.\n\n" + refresh },
      "unambiguously",
    ],
    ["unsupported queued credit", { preview: "Repair\n\n" + refresh, queue: true }, "Cannot queue"],
    ["queued machine credit", { preview: "Repair\n\n" + machine, queue: true }, "Cannot queue"],
    ["queued missing source credit", { source: human, queue: true }, "Cannot queue"],
    [
      "invalid source identity",
      { sourceCredit: true, authors: [author("Invalid\nName")] },
      "invalid source author",
    ],
    [
      "malformed preview credit",
      { preview: "Repair\n\nCo-authored-by: Missing email" },
      "validate squash preview",
    ],
    [
      "unknown squash title",
      { squashDefault: { title: "UNKNOWN", message: "PR_BODY", commits: [] } },
      "unsupported repository",
    ],
    [
      "unknown squash message",
      { squashDefault: { title: "PR_TITLE", message: "UNKNOWN", commits: [] } },
      "unsupported repository",
    ],
    [
      "missing commit messages",
      { squashDefault: { title: "PR_TITLE", message: "COMMIT_MESSAGES", commits: [] } },
      "published commits",
    ],
  ])("rejects %s", (_name, input, diagnostic) => {
    const result = compose(input);
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain(diagnostic);
  });

  it.each([
    machine,
    credit("App", "209825114+claude[bot]@users.noreply.github.com"),
    "  " + machine,
    machine + "\n  indented note",
    "Co-Authored-By: Claude\n <noreply@anthropic.com>",
  ])("rejects machine credit anywhere in reviewed bytes: %s", (line) => {
    const result = compose({ body: "Reviewed correction.\n\n" + line + "\n\nMore context.\n" });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("--body-file");
  });

  it("parses canonical trailers without executing configured trailer commands", () => {
    const marker = join(temps.make("merge-trailer-"), "invoked");
    const result = compose(
      { source: human },
      {
        ...process.env,
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "trailer.separators",
        GIT_CONFIG_VALUE_0: "%",
        GIT_CONFIG_KEY_1: "trailer.audit.key",
        GIT_CONFIG_VALUE_1: "Unrequested-Metadata",
        GIT_CONFIG_KEY_2: "trailer.audit.command",
        GIT_CONFIG_VALUE_2: `touch "${marker}"`,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Repair\n\n" + human + "\n");
    expect(existsSync(marker)).toBe(false);
  });

  it.each(["missing", "directory", "symlink", "fifo", "nul", "invalid-utf8"])(
    "rejects an invalid explicit body boundary: %s",
    (kind) => {
      const root = temps.make("merge-body-input-"),
        file = join(root, "body");
      if (kind === "directory") {
        mkdirSync(file);
      }
      if (kind === "symlink") {
        writeFileSync(join(root, "target"), "Valid body");
        symlinkSync(join(root, "target"), file);
      }
      if (kind === "fifo") {
        expect(spawnSync("mkfifo", [file]).status).toBe(0);
      }
      if (kind === "nul") {
        writeFileSync(file, Buffer.from([65, 0, 66]));
      }
      if (kind === "invalid-utf8") {
        writeFileSync(file, Buffer.from([0xff]));
      }
      const result = spawnSync(process.execPath, ["scripts/pr-lib/merge-body.mjs", "read", file], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result, result.stderr).toMatchObject({ status: 1, stdout: "" });
      expect(result.stderr).toContain("Cannot prepare merge body:");
    },
  );
});

describePosix("native squash attribution handoff", () => {
  it.each(["success", "rest", "source", "authors", "preview", "stale", "queue", "write"])(
    "binds the published and prepared Git history before body creation: %s",
    (fault) => {
      const root = temps.make("merge-attribution-");
      const env = createIndependentPrFixtureEnv({
        ...process.env,
        GIT_AUTHOR_NAME: "Maintainer",
        GIT_AUTHOR_EMAIL: "maintainer@example.com",
        GIT_COMMITTER_NAME: "Maintainer",
        GIT_COMMITTER_EMAIL: "maintainer@example.com",
        OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: join(root, "unrelated"),
        OPENCLAW_PR_LOCK_NOTIFY_FD: "3",
      });
      const { git, tree, commit } = createFixtureGit(root, env);
      git(["init", "-q"]);
      const base = commit(tree("base"), [], "Base\n\n" + credit("Main Only"));
      const main = commit(tree("main"), [base], "Main refresh");
      git(["update-ref", "refs/remotes/origin/main", main]);
      const key = join(root, "key");
      expect(spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]).status).toBe(0);
      writeFileSync(
        join(root, "signers"),
        "fixture@example.com " + readFileSync(key + ".pub", "utf8"),
      );
      for (const [name, value] of [
        ["gpg.format", "ssh"],
        ["user.signingKey", key],
        ["gpg.ssh.allowedSignersFile", join(root, "signers")],
      ]) {
        git(["config", name, value]);
      }
      const sourceCredit = credit("Élodie", "elodie@example.com");
      const sourceText = "Repair\n\nCo-authored-by: Élodie\n <elodie@example.com>\n";
      const published = commit(tree("repair"), [base], sourceText, author(), true);
      git(["verify-commit", published]);
      const merged = commit(
        tree("repair"),
        [published, main],
        "Refresh\n\n" + credit("Merge Helper") + "\n",
      );
      const prepared = commit(
        tree("repair"),
        [merged],
        "Fixup\n\n" + credit("Local Helper") + "\n",
      );
      git([
        "update-ref",
        "HEAD",
        commit(tree("later"), [prepared], "Later\n\n" + credit("Unprepared")),
      ]);
      git(["notes", "add", "-m", "Unrelated note", prepared]);
      for (const [name, value] of [
        ["log.showSignature", "true"],
        ["color.ui", "always"],
        ["log.decorate", "full"],
        ["i18n.logOutputEncoding", "ISO-8859-1"],
      ]) {
        git(["config", name, value]);
      }
      mkdirSync(join(root, ".local"));
      const record = {
        sha: published,
        commit: { author: author() },
        author: { login: "contributor", type: "User" },
      };
      writeFileSync(
        join(root, "gh"),
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = new URL(args[3], 'https://fixture.github.invalid');
if (args[0] !== 'api' || args[1] !== '--hostname' || args[2] !== 'fixture.github.invalid' ||
    endpoint.pathname !== '/repos/fixture/repo/commits' ||
    endpoint.searchParams.get('sha') !== '${published}' || endpoint.searchParams.get('per_page') !== '1') {
  throw new Error('Expected the bound attribution repository and source commit');
}
if ('${fault}' === 'authors') { console.error('fixture authors failure'); process.exit(1); }
console.log(${JSON.stringify(JSON.stringify([record]))});
`,
        { mode: 0o755 },
      );
      const preview = {
        transport: fault === "rest" ? "rest" : "graphql",
        payload: {
          data: {
            repository: {
              squashMergeCommitTitle: "COMMIT_OR_PR_TITLE",
              squashMergeCommitMessage: "COMMIT_MESSAGES",
              pullRequest: {
                headRefOid: fault === "stale" ? base : merged,
                isMergeQueueEnabled: fault === "queue",
                viewerMergeBodyText: "Server description",
              },
            },
          },
        },
      };
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
source "${join(process.cwd(), "scripts/pr-lib/merge.sh")}"
PREP_HEAD_SHA=${merged}
LOCAL_PREP_HEAD_SHA=${prepared}
PR_MAIN_SHA=${main}
MERGE_REPO_NAME=fixture/repo
MERGE_REPO_HOST=fixture.github.invalid
pr_git() { [ "${fault}" != source ] || { echo 'fixture source failure' >&2; return 1; }; command git "$@"; }
merge_read() { [ "${fault}" != preview ] || { echo 'fixture preview failure' >&2; return 1; }; printf '%s' '${JSON.stringify(preview)}'; }
mktemp() { [ "${fault}" != write ] || { echo 'fixture write failure' >&2; return 1; }; command mktemp "$@"; }
file=$(prepare_squash_merge_body 123)
cat "$file"
`,
        ],
        { cwd: root, encoding: "utf8", env: { ...env, OPENCLAW_GH_BIN: join(root, "gh") } },
      );
      if (fault !== "success" && fault !== "rest") {
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          fault === "stale"
            ? "require a current-head preview"
            : fault === "queue"
              ? "body overrides require a non-queue PR"
              : `fixture ${fault} failure`,
        );
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        fault === "rest"
          ? `* ${sourceText.trimEnd()}\n\n* Refresh\n\n${credit("Merge Helper")}\n${sourceCredit}\n${credit("Local Helper")}\n${human}\n`
          : "Server description\n\n" +
              [sourceCredit, credit("Merge Helper"), credit("Local Helper")].join("\n") +
              "\n",
      );
    },
  );
});
