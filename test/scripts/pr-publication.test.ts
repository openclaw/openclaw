import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
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

function publishedPair(f: ReturnType<typeof makePublisherRepo>, operation = "prepare_push") {
  const result = runPublisher(f, `${operation} 4242`, graphql);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
}

function intermediateReceipt(head: string, local: string, from: string) {
  return [
    `PUSH_PREP_HEAD_SHA=${head}`,
    `PUSH_LOCAL_PREP_HEAD_SHA=${local}`,
    `PUSHED_FROM_SHA=${from}`,
    "PUSH_REPLACED_HOSTED_ANCESTRY=false",
    `PR_HEAD_SHA_AFTER_PUSH=${head}`,
    "",
  ].join("\n");
}

describe("partial PR publication recovery", () => {
  it("resumes a verified GraphQL push after a failed gate without publishing or rewriting its lease", () => {
    const f = makePublisherRepo();
    writeFileSync(
      join(f.local, "gates.env"),
      `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\n`,
    );
    const failed = runPublisher(f, 'if prepare_push 4242; then exit 99; else exit "$?"; fi', [
      ...graphql,
      "finalize_remote_crabbox_aws_gate() { return 1; }",
    ]);
    expect(failed.status, failed.stdout + failed.stderr).toBe(1);
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    expect(readFileSync(join(f.local, "prep.md"), "utf8")).not.toContain("Gates passed");
    const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
    expect(hosted).not.toBe(f.candidate);
    const resultPath = join(f.local, "prepare-push-result.env");
    const receipt = readFileSync(resultPath, "utf8");
    expect(receipt).toBe(intermediateReceipt(hosted, f.candidate, f.source));
    const resumed = runPublisher(f, "prepare_push 4242", [
      ...graphql,
      'finalize_remote_crabbox_aws_gate() { write_gates_env_stamp "$1" false false remote_crabbox_aws "$2" "$2" "" aws run_fixture cbx_fixture https://github.com/fixture/repo/actions/runs/1; }',
    ]);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
    expect(readFileSync(resultPath, "utf8")).toBe(receipt);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
      `PR_HEAD_SHA_BEFORE=${f.source}\n`,
    );
    publishedPair(f);
    expect(readFileSync(resultPath, "utf8")).toBe(receipt);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
  });

  it.each(["prepare_push"])(
    "recovers %s from either intermediate owner without a completed receipt",
    (operation) => {
      const f = makePublisherRepo();
      const first = publishedPair(f);
      f.git("checkout", "-B", "prep", first);
      f.git("commit", "-qm", "next reviewed fixup", "--allow-empty");
      const latest = publishedPair(f, "prepare_sync_head");
      unlinkSync(join(f.local, "prep.env"));
      const latestResult = readFileSync(join(f.local, "prepare-sync-result.env"), "utf8");
      expect(publishedPair(f, operation)).toBe(latest);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
      expect(readFileSync(join(f.local, "prepare-sync-result.env"), "utf8")).toBe(latestResult);
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `PREP_HEAD_SHA=${latest}\n`,
      );
    },
  );

  it.each([true])(
    "selects the latest intermediate publication over completed preparation, completed=%s",
    () => {
      const f = makePublisherRepo();
      const first = publishedPair(f, "prepare_sync_head");
      const completed = readFileSync(join(f.local, "prep.env"), "utf8");
      f.git("checkout", "-B", "prep", first);
      f.git("commit", "-qm", "next reviewed fixup", "--allow-empty");
      const latest = publishedPair(f);
      writeFileSync(join(f.local, "prep.env"), completed);
      const latestResult = readFileSync(join(f.local, "prepare-push-result.env"), "utf8");
      expect(publishedPair(f, "prepare_sync_head")).toBe(latest);
      expect(readFileSync(join(f.local, "prepare-push-result.env"), "utf8")).toBe(latestResult);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
    },
  );

  it("does not fall back to the older matching receipt when a newer publication exists", () => {
    const f = makePublisherRepo();
    const first = publishedPair(f);
    f.git("checkout", "-B", "prep", first);
    f.git("commit", "-qm", "next reviewed fixup", "--allow-empty");
    const latest = publishedPair(f, "prepare_sync_head");
    unlinkSync(join(f.local, "prep.env"));
    f.git("checkout", "-B", "prep", f.candidate);
    const result = runPublisher(f, "prepare_push 4242", graphql);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(latest);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
    expect(existsSync(join(f.local, "prep.env"))).toBe(false);
  });

  it.each([false])("rejects an equal-head pair that drops completed ancestry, reversed=%s", () => {
    const f = makePublisherRepo();
    const first = publishedPair(f);
    const completed = readFileSync(join(f.local, "prep.env"), "utf8");
    f.git("checkout", "-B", "prep", first);
    f.git("commit", "-qm", "next reviewed fixup", "--allow-empty");
    const latest = publishedPair(f, "prepare_sync_head");
    const valid = readFileSync(join(f.local, "prepare-sync-result.env"), "utf8");
    const alternate = f.git(
      "commit-tree",
      `${latest}^{tree}`,
      "-p",
      f.source,
      "-m",
      "alternate local",
    );
    const invalid = intermediateReceipt(latest, alternate, first);
    writeFileSync(join(f.local, "prep.env"), completed);
    writeFileSync(join(f.local, "prepare-push-result.env"), valid);
    writeFileSync(join(f.local, "prepare-sync-result.env"), invalid);
    f.git("checkout", "-B", "prep", alternate);
    const result = runPublisher(f, "prepare_push 4242", graphql);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(completed);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
  });

  it("accepts duplicate native no-op receipts without inventing a different local mapping", () => {
    const f = makePublisherRepo();
    const hosted = publishedPair(f);
    const resultPath = join(f.local, "prepare-sync-result.env");
    const noop = intermediateReceipt(hosted, f.candidate, hosted);
    writeFileSync(resultPath, noop);
    unlinkSync(join(f.local, "prep.env"));
    expect(publishedPair(f, "prepare_sync_head")).toBe(hosted);
    expect(readFileSync(resultPath, "utf8")).toBe(noop);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
  });

  it.each([
    { reversed: false, failure: "incomparable" },
    { reversed: false, failure: "intermediate-local-parent" },
    { reversed: false, failure: "completed-local-parent" },
  ])(
    "rejects inconsistent $failure records below completed preparation, reversed=$reversed",
    ({ failure }) => {
      const f = makePublisherRepo();
      const first = publishedPair(f);
      const second =
        failure === "incomparable"
          ? f.sameTree
          : f.git("commit-tree", `${first}^{tree}`, "-p", first, "-m", "second publication");
      const completed = f.git(
        "commit-tree",
        `${first}^{tree}`,
        "-p",
        first,
        "-p",
        second,
        "-m",
        "completed reconciliation",
      );
      const completedLocal = failure === "completed-local-parent" ? f.candidate : completed;
      const receipt = readFileSync(join(f.local, "prep.env"), "utf8")
        .replace(`PREP_HEAD_SHA=${first}\n`, `PREP_HEAD_SHA=${completed}\n`)
        .replace(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`, `LOCAL_PREP_HEAD_SHA=${completedLocal}\n`);
      const firstResult = intermediateReceipt(first, f.candidate, f.source);
      const secondResult = intermediateReceipt(
        second,
        failure === "intermediate-local-parent" ? f.candidate : second,
        f.source,
      );
      writeFileSync(join(f.local, "prep.env"), receipt);
      writeFileSync(join(f.local, "prepare-push-result.env"), firstResult);
      writeFileSync(join(f.local, "prepare-sync-result.env"), secondResult);
      f.git("checkout", "-B", "prep", completedLocal);

      const result = runPublisher(f, "prepare_push 4242", graphql);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Conflicting publication receipts");
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(receipt);
      expect(readFileSync(join(f.local, "prepare-push-result.env"), "utf8")).toBe(firstResult);
      expect(readFileSync(join(f.local, "prepare-sync-result.env"), "utf8")).toBe(secondResult);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(first);
    },
  );

  it.each(["duplicate", "missing", "head", "source", "local-tree", "symlink", "shell"])(
    "refuses a %s intermediate receipt without executing or replacing it",
    (failure) => {
      const f = makePublisherRepo();
      const hosted = publishedPair(f);
      unlinkSync(join(f.local, "prep.env"));
      const resultPath = join(f.local, "prepare-push-result.env");
      let receipt = readFileSync(resultPath, "utf8");
      switch (failure) {
        case "duplicate":
          receipt += `PUSH_PREP_HEAD_SHA=${hosted}\n`;
          break;
        case "missing":
          receipt = receipt.replace(`PUSHED_FROM_SHA=${f.source}\n`, "");
          break;
        case "head":
          receipt = receipt.replace(
            `PR_HEAD_SHA_AFTER_PUSH=${hosted}`,
            `PR_HEAD_SHA_AFTER_PUSH=${f.source}`,
          );
          break;
        case "source":
          receipt = receipt.replace(`PUSHED_FROM_SHA=${f.source}`, `PUSHED_FROM_SHA=${f.base}`);
          break;
        case "local-tree":
          receipt = receipt.replace(
            `PUSH_LOCAL_PREP_HEAD_SHA=${f.candidate}`,
            `PUSH_LOCAL_PREP_HEAD_SHA=${f.source}`,
          );
          break;
        case "shell":
          receipt = receipt.replace(
            `PUSHED_FROM_SHA=${f.source}`,
            "PUSHED_FROM_SHA=$(touch .local/executed)",
          );
          break;
        case "symlink":
          writeFileSync(join(f.local, "retained-result.env"), receipt);
          unlinkSync(resultPath);
          symlinkSync("retained-result.env", resultPath);
          break;
      }
      if (failure !== "symlink") {
        writeFileSync(resultPath, receipt);
      }
      const result = runPublisher(f, "prepare_push 4242", graphql);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(readFileSync(resultPath, "utf8")).toBe(receipt);
      expect(existsSync(join(f.local, "executed"))).toBe(false);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
    },
  );
});

describe("PR publication ownership", () => {
  it.each([false, true])(
    "binds deferred GitHub gates to verified publication (stale target=%s)",
    (staleTarget) => {
      const f = makePublisherRepo();
      const gatesPath = join(f.local, "gates.env");
      const gates = `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${staleTarget ? f.source : f.candidate}\n`;
      writeFileSync(gatesPath, gates);
      const result = runPublisher(f, "prepare_push 4242", [
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        "OPENCLAW_PR_PUSH_MODE=graphql",
      ]);
      expect(result.status, result.stdout + result.stderr).toBe(staleTarget ? 1 : 0);
      const events = readFileSync(join(f.local, "events"), "utf8");
      if (staleTarget) {
        expect(events).toBe("");
        expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
        expect(readFileSync(gatesPath, "utf8")).toBe(gates);
        expect(existsSync(join(f.local, "prep.env"))).toBe(false);
        return;
      }
      const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
      expect(events).toBe("graphql\n");
      expect(hosted).not.toBe(f.candidate);
      expect(readFileSync(gatesPath, "utf8")).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${hosted}\n`);
      expect(readFileSync(gatesPath, "utf8")).not.toMatch(
        /VERIFIED|PASSED|FULL_GATES|REMOTE_GATES/,
      );
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `PREP_HEAD_SHA=${hosted}\n`,
      );
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).toContain("GitHub gates deferred");
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).not.toContain("Gates passed");
    },
  );

  it.each(["git", "graphql"])(
    "revalidates identity after %s publication planning and before the write",
    (transport) => {
      const f = makePublisherRepo();
      const result = runPublisher(f, "prepare_sync_head 4242", [
        `OPENCLAW_PR_PUSH_MODE=${transport}`,
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        "pr_git() {",
        `  if [ "$1" = verify-commit ] || [ "$*" = 'log -1 --format=%b HEAD' ]; then`,
        "    jq '.headRepository.nameWithOwner = \"replacement/repo\"' .local/remote-observation.json > .local/changed-observation.json",
        "    mv .local/changed-observation.json .local/remote-observation.json",
        '    [ "$1" != verify-commit ] || return 0',
        "  fi",
        '  [ "$1" != push ] || echo push >> .local/events',
        '  command git "$@"',
        "}",
      ]);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("PR identity changed");
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    },
  );

  it.each(["base-repository", "base-branch", "closed"])(
    "refuses changed %s identity before publication without relying on a matching head",
    (movement) => {
      const f = makePublisherRepo();
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
      writeFileSync(join(f.local, "remote-observation.json"), JSON.stringify(remote));
      const result = runPublisher(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("PR identity changed");
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    },
  );

  it.each([{ operation: "prepare_push", movement: "same-tree" }])(
    "$operation refuses a foreign $movement observed before publication",
    ({ operation }) => {
      const f = makePublisherRepo();
      const foreign = f.sameTree;
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", foreign);
      const before = readFileSync(join(f.local, "prep.md"), "utf8");
      const result = runPublisher(f, `${operation} 4242`);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).toBe(before);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
    },
  );

  it.each(["same-tree"] as const)(
    "keeps the original lease when a foreign %s races the push",
    () => {
      const f = makePublisherRepo();
      const foreign = f.sameTree;
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      const result = runPublisher(f, "prepare_push 4242", [
        "pr_git() {",
        '  if [ "$1" = push ]; then',
        "    echo push >> .local/events",
        `    command git --git-dir="$remote" update-ref refs/heads/topic ${foreign}`,
        '  elif [ "$1" = rebase ]; then echo rebase >> .local/events; fi',
        '  command git "$@"',
        "}",
      ]);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\n");
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
      expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
        `LAST_VERIFIED_HEAD_SHA=${f.candidate}`,
      );
    },
  );

  it.each(["readback", "fetch"] as const)(
    "does not stamp a same-tree replacement at the post-publication %s",
    (boundary) => {
      const f = makePublisherRepo();
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
          : [
              "pr_git() {",
              '  if [ "$1" = push ]; then echo push >> .local/events; fi',
              '  for arg in "$@"; do',
              '    if [ "$arg" = fetch ]; then',
              `      command git --git-dir="$remote" update-ref refs/heads/topic ${f.sameTree}`,
              "    fi",
              "  done",
              '  command git "$@"',
              "}",
            ],
      );
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.sameTree);
      expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
    },
  );

  it.each(["prepare_push"])(
    "%s rejects a same-tree no-op that lost reviewed ancestry",
    (operation) => {
      const f = makePublisherRepo();
      const foreign = f.git(
        "commit-tree",
        `${f.candidate}^{tree}`,
        "-p",
        f.base,
        "-m",
        "replaced reviewed ancestry",
      );
      f.git("checkout", "-B", "prep", foreign);
      f.git("push", "-q", "origin", `${foreign}:refs/heads/foreign`);
      f.git("--git-dir", f.remote, "update-ref", "refs/heads/topic", foreign);
      const before = readFileSync(join(f.local, "prep.md"), "utf8");
      const result = runPublisher(f, `${operation} 4242`);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.git("rev-parse", "HEAD")).toBe(foreign);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(foreign);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).toBe(before);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-sync-result.env"))).toBe(false);
      expect(existsSync(join(f.local, "prepare-push-result.env"))).toBe(false);
    },
  );

  it("accepts the returned GraphQL OID but requires later fixups to extend it", () => {
    const f = makePublisherRepo();
    const first = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
    expect(hosted).not.toBe(f.candidate);
    expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
    let receipt = readFileSync(join(f.local, "prep.env"), "utf8");
    expect(receipt).toContain(`PREP_HEAD_SHA=${hosted}\n`);
    expect(receipt).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
    const noop = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(noop.status, noop.stdout + noop.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
    receipt = readFileSync(join(f.local, "prep.env"), "utf8");
    f.git("commit", "-qm", "fixup on the unhosted local commit", "--allow-empty");
    const rejected = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(rejected.status, rejected.stdout + rejected.stderr).not.toBe(0);
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toBe(receipt);
    f.git("checkout", "-B", "prep", hosted);
    f.git("commit", "-qm", "fixup on the hosted commit", "--allow-empty");
    const accepted = runPublisher(f, "prepare_sync_head 4242", graphql);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\ngraphql\n");
  });

  it.each(["git-failure", "graphql-permission"] as const)(
    "limits transport fallback for %s",
    (failure) => {
      const f = makePublisherRepo();
      const result = runPublisher(f, "prepare_sync_head 4242", [
        "PR_HEAD_OWNER=fixture",
        "PR_HEAD_REPO_NAME=repo",
        ...(failure === "graphql-permission"
          ? [
              "OPENCLAW_PR_PUSH_MODE=graphql",
              'pr_gh_plain() { echo graphql >> .local/events; echo "403 forbidden" >&2; return 74; }',
            ]
          : [
              "pr_git() {",
              '  if [ "$1" = push ]; then',
              "    echo push >> .local/events",
              '    echo "transport failed" >&2',
              "    return 73",
              "  fi",
              '  command git "$@"',
              "}",
            ]),
      ]);
      expect(result.status, result.stdout + result.stderr).toBe(failure === "git-failure" ? 73 : 1);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe(
        failure === "git-failure" ? "push\n" : "graphql\n",
      );
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    },
  );

  it.each(["number", "source", "local-tree"] as const)(
    "rejects a prior receipt with mismatched %s provenance",
    (mismatch) => {
      const f = makePublisherRepo();
      const first = runPublisher(f);
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const path = join(f.local, "prep.env");
      const before = readFileSync(path, "utf8");
      const changes = {
        number: ["PR_NUMBER=4242", "PR_NUMBER=4243"],
        source: [`PR_HEAD_SHA_BEFORE=${f.source}`, `PR_HEAD_SHA_BEFORE=${f.base}`],
        "local-tree": [`LOCAL_PREP_HEAD_SHA=${f.candidate}`, `LOCAL_PREP_HEAD_SHA=${f.source}`],
      } as const;
      const [from, to] = changes[mismatch];
      const changed = before.replace(from, to);
      expect(changed).not.toBe(before);
      writeFileSync(path, changed);
      f.git("commit", "-qm", "appended fixup", "--allow-empty");
      const result = runPublisher(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(changed);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\n");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.candidate);
    },
  );
});
