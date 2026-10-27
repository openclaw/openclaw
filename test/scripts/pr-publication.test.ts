import { symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPublisherRepoFactory, runPublisher } from "./pr-prepare.test-support.js";

const makePublisherRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates: useAutoCleanupTempDirTracker(afterAll),
});
const graphql = [
  "PR_HEAD_OWNER=fixture",
  "PR_HEAD_REPO_NAME=repo",
  "OPENCLAW_PR_PUSH_MODE=graphql",
];

type Publisher = ReturnType<typeof makePublisherRepo>;
type Run = ReturnType<typeof runPublisher>;
let f: Publisher;
beforeEach(() => {
  f = makePublisherRepo();
});
const remoteHead = () => f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
const gitHook = (...commands: string[]) => ["pr_git() {", ...commands, '  command git "$@"', "}"];
function expectUnpublished(result: Run, remote = f.source, events = "") {
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect({ remote: remoteHead(), events: f.read("events"), prep: f.exists("prep.env") }).toEqual({
    remote,
    events,
    prep: false,
  });
}
function expectRetained(result: Run, receipts: Record<string, string>, events: string) {
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(f.read("events")).toBe(events);
  for (const [name, contents] of Object.entries(receipts)) {
    expect(f.read(name), name).toBe(contents);
  }
}
function publishedPair(operation = "prepare_push", setup = graphql) {
  const result = runPublisher(f, `${operation} 4242`, setup);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return remoteHead();
}

function publicationChain(initial = "prepare_push") {
  const first = publishedPair(initial),
    completed = f.read("prep.env");
  f.git("checkout", "-B", "prep", first);
  f.git("commit", "-qm", "next reviewed fixup", "--allow-empty");
  const latest = publishedPair(initial === "prepare_push" ? "prepare_sync_head" : "prepare_push");
  return { first, latest, completed };
}

function commitTree(tree: string, parents: string[], message: string) {
  return f.git(
    "commit-tree",
    `${tree}^{tree}`,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    message,
  );
}

function intermediateReceipt(head: string, local: string, from: string) {
  return `PUSH_PREP_HEAD_SHA=${head}\nPUSH_LOCAL_PREP_HEAD_SHA=${local}\nPUSHED_FROM_SHA=${from}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${head}\n`;
}

describe("partial PR publication recovery", () => {
  it("resumes a verified GraphQL push after a failed gate without publishing or rewriting its lease", () => {
    f.write(
      "gates.env",
      `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\n`,
    );
    const failed = runPublisher(f, 'if prepare_push 4242; then exit 99; else exit "$?"; fi', [
      ...graphql,
      "finalize_remote_crabbox_aws_gate() { return 1; }",
    ]);
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(f.exists("prep.env")).toBe(false);
    expect(f.read("prep.md")).not.toContain("Gates passed");
    const hosted = remoteHead();
    expect(hosted).not.toBe(f.candidate);
    const resultFile = "prepare-push-result.env";
    const receipt = f.read(resultFile);
    expect(receipt).toBe(intermediateReceipt(hosted, f.candidate, f.source));
    const resumed = runPublisher(f, "prepare_push 4242", [
      ...graphql,
      'finalize_remote_crabbox_aws_gate() { write_gates_env_stamp "$1" false false remote_crabbox_aws "$2" "$2" "" aws run_fixture cbx_fixture https://github.com/fixture/repo/actions/runs/1; }',
    ]);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(f.read("events")).toBe("graphql\n");
    expect(f.read(resultFile)).toBe(receipt);
    expect(f.read("prep.env")).toContain(`PR_HEAD_SHA_BEFORE=${f.source}\n`);
    publishedPair();
    expect(f.read(resultFile)).toBe(receipt);
    expect(f.read("events")).toBe("graphql\n");
  });

  it.each(["missing", "older"])("recovers the latest publication with %s preparation", (prep) => {
    const initial = prep === "missing" ? "prepare_push" : "prepare_sync_head";
    const { latest, completed } = publicationChain(initial);
    if (prep === "missing") {
      unlinkSync(join(f.local, "prep.env"));
    } else {
      f.write("prep.env", completed);
    }
    const resultFile = prep === "missing" ? "prepare-sync-result.env" : "prepare-push-result.env";
    const latestResult = f.read(resultFile);
    expect(publishedPair(initial)).toBe(latest);
    expect(f.read(resultFile)).toBe(latestResult);
    expect(f.read("events")).toBe("graphql\ngraphql\n");
    if (prep === "missing") {
      expect(f.read("prep.env")).toContain(`PREP_HEAD_SHA=${latest}\n`);
    }
  });
  it("does not fall back to the older matching receipt when a newer publication exists", () => {
    const { latest } = publicationChain();
    unlinkSync(join(f.local, "prep.env"));
    f.git("checkout", "-B", "prep", f.candidate);
    const result = runPublisher(f, "prepare_push 4242", graphql);
    expectUnpublished(result, latest, "graphql\ngraphql\n");
  });

  it("rejects an equal-head pair that drops completed ancestry", () => {
    const { first, latest, completed } = publicationChain();
    const valid = f.read("prepare-sync-result.env");
    const alternate = commitTree(latest, [f.source], "alternate local");
    const invalid = intermediateReceipt(latest, alternate, first);
    f.write("prep.env", completed);
    f.write("prepare-push-result.env", valid);
    f.write("prepare-sync-result.env", invalid);
    f.git("checkout", "-B", "prep", alternate);
    const result = runPublisher(f, "prepare_push 4242", graphql);
    expectRetained(result, { "prep.env": completed }, "graphql\ngraphql\n");
  });

  it("accepts duplicate native no-op receipts without inventing a different local mapping", () => {
    const hosted = publishedPair();
    const resultFile = "prepare-sync-result.env";
    const noop = intermediateReceipt(hosted, f.candidate, hosted);
    f.write(resultFile, noop);
    unlinkSync(join(f.local, "prep.env"));
    expect(publishedPair("prepare_sync_head")).toBe(hosted);
    expect(f.read(resultFile)).toBe(noop);
    expect(f.read("events")).toBe("graphql\n");
  });

  it.each(["incomparable", "intermediate-local-parent", "completed-local-parent"])(
    "rejects inconsistent %s records below completed preparation",
    (failure) => {
      const first = publishedPair();
      const second =
        failure === "incomparable" ? f.sameTree : commitTree(first, [first], "second publication");
      const completed = commitTree(first, [first, second], "completed reconciliation");
      const completedLocal = failure === "completed-local-parent" ? f.candidate : completed;
      const receipt = f
        .read("prep.env")
        .replace(`PREP_HEAD_SHA=${first}\n`, `PREP_HEAD_SHA=${completed}\n`)
        .replace(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`, `LOCAL_PREP_HEAD_SHA=${completedLocal}\n`);
      const firstResult = intermediateReceipt(first, f.candidate, f.source);
      const secondResult = intermediateReceipt(
        second,
        failure === "intermediate-local-parent" ? f.candidate : second,
        f.source,
      );
      f.write("prep.env", receipt);
      f.write("prepare-push-result.env", firstResult);
      f.write("prepare-sync-result.env", secondResult);
      f.git("checkout", "-B", "prep", completedLocal);

      const result = runPublisher(f, "prepare_push 4242", graphql);
      expectRetained(
        result,
        {
          "prep.env": receipt,
          "prepare-push-result.env": firstResult,
          "prepare-sync-result.env": secondResult,
        },
        "graphql\n",
      );
      expect(result.stderr).toContain("Conflicting publication receipts");
      expect(remoteHead()).toBe(first);
    },
  );

  it.each(["duplicate", "missing", "head", "source", "local-tree", "symlink", "shell"] as const)(
    "refuses a %s intermediate receipt without executing or replacing it",
    (failure) => {
      const hosted = publishedPair();
      unlinkSync(join(f.local, "prep.env"));
      const resultFile = "prepare-push-result.env";
      let receipt = f.read(resultFile);
      if (failure === "duplicate") {
        receipt += `PUSH_PREP_HEAD_SHA=${hosted}\n`;
      } else if (failure === "symlink") {
        f.write("retained-result.env", receipt);
        unlinkSync(join(f.local, resultFile));
        symlinkSync("retained-result.env", join(f.local, resultFile));
      } else {
        const changes = {
          missing: [`PUSHED_FROM_SHA=${f.source}\n`, ""],
          head: [`PR_HEAD_SHA_AFTER_PUSH=${hosted}`, `PR_HEAD_SHA_AFTER_PUSH=${f.source}`],
          source: [`PUSHED_FROM_SHA=${f.source}`, `PUSHED_FROM_SHA=${f.base}`],
          "local-tree": [
            `PUSH_LOCAL_PREP_HEAD_SHA=${f.candidate}`,
            `PUSH_LOCAL_PREP_HEAD_SHA=${f.source}`,
          ],
          shell: [`PUSHED_FROM_SHA=${f.source}`, "PUSHED_FROM_SHA=$(touch .local/executed)"],
        } as const;
        const [from, to] = changes[failure];
        receipt = receipt.replace(from, to);
      }
      if (failure !== "symlink") {
        f.write(resultFile, receipt);
      }
      const result = runPublisher(f, "prepare_push 4242", graphql);
      expectRetained(result, { [resultFile]: receipt }, "graphql\n");
      expect(f.exists("executed")).toBe(false);
      expect(f.exists("prep.env")).toBe(false);
    },
  );
});

describe("PR publication ownership", () => {
  it("rejects deferred GitHub gates for a stale target without changing the receipt", () => {
    const gates = `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.source}\n`;
    f.write("gates.env", gates);
    expectUnpublished(runPublisher(f, "prepare_push 4242", graphql));
    expect(f.read("gates.env")).toBe(gates);
  });

  it.each(["git", "graphql"])(
    "revalidates identity after %s publication planning and before the write",
    (transport) => {
      const result = runPublisher(f, "prepare_sync_head 4242", [
        `OPENCLAW_PR_PUSH_MODE=${transport}`,
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        ...gitHook(
          `  if [ "$1" = verify-commit ] || [ "$*" = 'log -1 --format=%b HEAD' ]; then`,
          "    jq '.headRepository.nameWithOwner = \"replacement/repo\"' .local/remote-observation.json > .local/changed-observation.json",
          "    mv .local/changed-observation.json .local/remote-observation.json",
          '    [ "$1" != verify-commit ] || return 0',
          "  fi",
          '  [ "$1" != push ] || echo push >> .local/events',
        ),
      ]);
      expectUnpublished(result);
      expect(result.stdout + result.stderr).toContain("PR identity changed");
    },
  );

  it.each(["base-repository", "base-branch", "closed"])(
    "refuses changed %s identity before publication without relying on a matching head",
    (movement) => {
      const remote = structuredClone(f.observation);
      if (movement === "base-repository") {
        remote.baseRepository.id = "R_replacement";
      }
      if (movement === "base-branch") {
        remote.baseRefName = "release";
      }
      if (movement === "closed") {
        remote.state = "CLOSED";
      }
      f.write("remote-observation.json", JSON.stringify(remote));
      const result = runPublisher(f);
      expectUnpublished(result);
      expect(result.stdout + result.stderr).toContain("PR identity changed");
    },
  );

  it.each(["foreign head", "lost reviewed ancestry"])(
    "prepare-push refuses a same-tree %s before publication",
    (kind) => {
      const foreign =
        kind === "foreign head"
          ? f.sameTree
          : commitTree(f.candidate, [f.base], "replaced reviewed ancestry");
      if (kind !== "foreign head") {
        f.git("checkout", "-B", "prep", foreign);
      }
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", foreign);
      const before = f.read("prep.md");
      const result = runPublisher(f, "prepare_push 4242");
      expectUnpublished(result, foreign);
      expect(f.git("rev-parse", "HEAD")).toBe(kind === "foreign head" ? f.candidate : foreign);
      expect(f.read("prep.md")).toBe(before);
      expect([f.exists("prepare-sync-result.env"), f.exists("prepare-push-result.env")]).toEqual([
        false,
        false,
      ]);
    },
  );
  it("keeps the original lease when a foreign same-tree head races the push", () => {
    const foreign = f.sameTree;
    f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
    const result = runPublisher(f, "prepare_push 4242", [
      ...gitHook(
        '  if [ "$1" = push ]; then',
        "    echo push >> .local/events",
        `    command git --git-dir="$remote" update-ref refs/heads/topic ${foreign}`,
        '  elif [ "$1" = rebase ]; then echo rebase >> .local/events; fi',
      ),
    ]);
    expectUnpublished(result, foreign, "push\n");
    expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
    expect(f.exists("prepare-push-result.env")).toBe(false);
    expect(f.read("gates.env")).toContain(`LAST_VERIFIED_HEAD_SHA=${f.candidate}`);
  });
  it.each(["readback", "fetch"] as const)(
    "does not stamp a same-tree replacement at the post-publication %s",
    (boundary) => {
      f.git("push", "-q", "origin", `${f.sameTree}:refs/heads/foreign`);
      const result = runPublisher(
        f,
        "prepare_sync_head 4242",
        boundary === "readback"
          ? [
              "wait_for_pr_head_sha() {",
              '  test "$(remote_head)" = "$2" || return 1',
              '  pr_observe "$1" || return 1',
              `  command git --git-dir="$remote" update-ref refs/heads/topic ${f.sameTree}`,
              "}",
            ]
          : gitHook(
              '  if [ "$1" = push ]; then echo push >> .local/events; fi',
              '  for arg in "$@"; do',
              '    if [ "$arg" = fetch ]; then',
              `      command git --git-dir="$remote" update-ref refs/heads/topic ${f.sameTree}`,
              "    fi",
              "  done",
            ),
      );
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(remoteHead()).toBe(f.sameTree);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(f.exists("prep.env")).toBe(false);
      expect(f.exists("prepare-sync-result.env")).toBe(false);
    },
  );

  it("accepts the returned GraphQL OID but requires later fixups to extend it", () => {
    const hosted = publishedPair("prepare_sync_head");
    expect(hosted).not.toBe(f.candidate);
    expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
    let receipt = f.read("prep.env");
    expect(receipt).toContain(`PREP_HEAD_SHA=${hosted}\n`);
    expect(receipt).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
    publishedPair("prepare_sync_head");
    expect(f.read("events")).toBe("graphql\n");
    receipt = f.read("prep.env");
    f.git("commit", "-qm", "fixup on the unhosted local commit", "--allow-empty");
    const rejected = runPublisher(f, "prepare_sync_head 4242", graphql);
    expectRetained(rejected, { "prep.env": receipt }, "graphql\n");
    f.git("checkout", "-B", "prep", hosted);
    f.git("commit", "-qm", "fixup on the hosted commit", "--allow-empty");
    publishedPair("prepare_sync_head");
    expect(f.read("events")).toBe("graphql\ngraphql\n");
  });

  it.each(["git-failure", "graphql-permission"] as const)(
    "limits transport fallback for %s",
    (failure) => {
      const result = runPublisher(f, "prepare_sync_head 4242", [
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        ...(failure === "graphql-permission"
          ? [
              "OPENCLAW_PR_PUSH_MODE=graphql",
              'pr_gh_plain() { echo graphql >> .local/events; echo "403 forbidden" >&2; return 74; }',
            ]
          : gitHook(
              '  if [ "$1" = push ]; then',
              "    echo push >> .local/events",
              '    echo "transport failed" >&2',
              "    return 73",
              "  fi",
            )),
      ]);
      expect(result.status, result.stdout + result.stderr).toBe(failure === "git-failure" ? 73 : 1);
      expect(f.read("events")).toBe(failure === "git-failure" ? "push\n" : "graphql\n");
      expect(f.exists("prep.env")).toBe(false);
    },
  );

  it.each(["number", "source", "local-tree"] as const)(
    "rejects a prior receipt with mismatched %s provenance",
    (mismatch) => {
      publishedPair("prepare_sync_head", []);
      const before = f.read("prep.env");
      const changes = {
        number: ["PR_NUMBER=4242", "PR_NUMBER=4243"],
        source: [`PR_HEAD_SHA_BEFORE=${f.source}`, `PR_HEAD_SHA_BEFORE=${f.base}`],
        "local-tree": [`LOCAL_PREP_HEAD_SHA=${f.candidate}`, `LOCAL_PREP_HEAD_SHA=${f.source}`],
      } as const;
      const [from, to] = changes[mismatch];
      const changed = before.replace(from, to);
      expect(changed).not.toBe(before);
      f.write("prep.env", changed);
      f.git("commit", "-qm", "appended fixup", "--allow-empty");
      const result = runPublisher(f);
      expectRetained(result, { "prep.env": changed }, "push\n");
      expect(remoteHead()).toBe(f.candidate);
    },
  );
});
