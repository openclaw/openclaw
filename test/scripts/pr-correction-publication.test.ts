import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPublisherRepoFactory, runPublisher } from "./pr-prepare.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const makePublisherRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates,
});
const describePosix = process.platform === "win32" ? describe.skip : describe;

function reviewFor(head: string, ready = false) {
  const review = validReview(head);
  review.pr.number = 4242;
  review.issueValidation.status = "valid";
  review.recommendation = ready ? "READY FOR /prepare-pr" : review.recommendation;
  return review;
}

function fixture() {
  const f = makePublisherRepo();
  const { write } = f;
  const writeJson = (name: string, value: unknown) => f.write(name, JSON.stringify(value));
  // Metadata is native fixture state, never part of the reviewed candidate.
  appendFileSync(join(f.repoDir, ".git/info/exclude"), "\n.local/\n");
  f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "";
  f.env.OPENCLAW_PR_PUSH_MODE = "graphql";
  const metadata = { ...f.observation, baseRefOid: f.base, files: [{ path: "reviewed.txt" }] };
  writeJson("pr-meta.json", metadata);
  writeJson("remote-observation.json", metadata);
  const incoming = reviewFor(f.source);
  incoming.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Incorrect publication behavior",
    area: "reviewed.txt",
    fix: "Preserve publication authority",
  });
  const incomingBytes = JSON.stringify(incoming);
  write("review.json", incomingBytes);
  write("correction-incoming-review.json", incomingBytes);
  const incomingOid = f.git("hash-object", "--no-filters", ".local/review.json");
  appendFileSync(
    join(f.local, "prep-context.env"),
    `PREP_REVIEW_MODE=correction\nPREP_INCOMING_JSON_OID=${incomingOid}\n`,
  );
  writeJson("correction-review.json", {
    ...reviewFor(f.candidate, true),
    correction: {
      incomingHeadSha: f.source,
      incomingReviewJsonOid: incomingOid,
      resolvedFindings: [{ id: "I1", resolution: "The publication fix is reviewed." }],
    },
  });
  write(
    "gates.env",
    `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nREMOTE_GATES_PROVIDER=aws\n`,
  );
  return {
    ...f,
    writeJson,
    hosted: () => f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic"),
  };
}

function runCorrection(
  f: ReturnType<typeof fixture>,
  options: { command?: string; setup?: string[]; duringProof?: string } = {},
) {
  return runPublisher(f, options.command ?? "prepare_push 4242", [
    // Preserve the fixture transport before review.sh reloads the GitHub helpers.
    "eval \"$(declare -f pr_gh_plain | sed '1s/pr_gh_plain/fixture_gh_plain/')\"",
    // Restore the actual correction owner instead of the generic publisher fixture's stub.
    'source "$script_parent_dir/pr-lib/review.sh"',
    'pr_gh_run() { echo "unexpected external GitHub request" >&2; return 98; }',
    "PR_HEAD_OWNER=fixture",
    "PR_HEAD_REPO_NAME=repo",
    "pr_gh() {",
    '  echo "$*" >> .local/github-reads',
    '  case "$*" in',
    '    "pr view "*) jq -c --arg sha "$(remote_head)" ".headRefOid = \\$sha" .local/remote-observation.json;;',
    '    *) echo "unexpected GitHub request" >&2; return 98;;',
    "  esac",
    "}",
    // Keep transport publication real against the bare fixture remote; only GitHub is synthetic.
    "pr_gh_writer_login() { echo fixture; }",
    "pr_gh_plain() {",
    '  if [ "$1" = api ] && [ "$2" = orgs/openclaw/memberships/fixture ]; then',
    '    printf \'{"state":"active","role":"admin"}\\n\'',
    '  else fixture_gh_plain "$@"; fi',
    "}",
    // The protected publisher is the external process boundary. The real finalizer
    // must validate its exact tuple and revalidate correction custody afterward.
    "run_quiet_logged() {",
    '  [ "$3" = node ] && [ "$4" = "$script_parent_dir/pr-lib/ci-dispatch.mjs" ] || return 97',
    "  echo proof >> .local/events",
    options.duringProof ?? ":",
    '  jq -nc --arg head "$7" --arg base "$8" \'{backend:"crabbox",provider:"aws",target:"linux",headSha:$head,baseSha:$base,workflowSha:$base,runId:"run_fixture",leaseId:"cbx_fixture",actionsRunUrl:"https://github.com/openclaw/openclaw/actions/runs/1",actionsRunAttempt:1}\' > "$2"',
    "}",
    ...(options.setup ?? []),
  ]);
}

function expectIncomplete(f: ReturnType<typeof fixture>) {
  expect(f.exists("prep.env")).toBe(false);
  expect(f.read("gates.env")).toContain("GATES_MODE=remote_crabbox_aws_pending\n");
  expect(f.read("prep.md")).not.toContain("Gates passed");
}

describePosix("correction publication authority handoff", () => {
  it.each([
    ["prepare_push", "crabbox"],
    ["prepare_push", "github"],
    ["prepare_sync_head", "github"],
  ] as const)("publishes a reviewed correction through %s with %s gates", (command, backend) => {
    const f = fixture();
    const before = f.read("review.json");
    if (backend === "github") {
      f.write(
        "gates.env",
        `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.candidate}\n`,
      );
    }
    const result = runCorrection(f, { command: `${command} 4242` });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const hosted = f.hosted();
    const gates = f.read("gates.env");
    const events = `graphql\n${backend === "crabbox" ? "proof\n" : ""}`;
    expect(hosted).not.toBe(f.candidate);
    expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
    expect(f.read("events")).toBe(events);
    const receipt = command === "prepare_push" ? "prepare-push" : "prepare-sync";
    expect(f.read(`${receipt}-result.env`)).toContain(`PUSH_PREP_HEAD_SHA=${hosted}\n`);
    expect(f.read("prep.env")).toContain(`LOCAL_PREP_HEAD_SHA=${f.candidate}\n`);
    expect(f.read("review.json")).toBe(before);
    if (backend === "crabbox") {
      expect(f.read("prepare-push-result.env")).toContain(`PUSHED_FROM_SHA=${f.source}\n`);
      expect(f.read("prep.env")).toContain(`PREP_HEAD_SHA=${hosted}\n`);
      expect(gates).toContain(
        `GATES_MODE=remote_crabbox_aws\nHOSTED_GATES_TARGET_HEAD_SHA=''\nLAST_VERIFIED_HEAD_SHA=${hosted}\nFULL_GATES_HEAD_SHA=${hosted}\n`,
      );
    } else {
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${hosted}\n`);
      expect(gates).not.toMatch(/GATES_PASSED_AT|LAST_VERIFIED_HEAD_SHA|FULL_GATES_HEAD_SHA/);
      expect(f.read("prep.md")).not.toContain("Gates passed");
      const resumed = runCorrection(f);
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(f.read("gates.env")).toBe(gates);
      expect(f.read("events")).toBe(events);
      expect(f.read("review.json")).toBe(before);
    }
  });

  it.each(["missing", "foreign-pr"])(
    "refuses pending correction publication with %s binding",
    (fault) => {
      const f = fixture();
      f.write(
        "gates.env",
        `PR_NUMBER=${fault === "foreign-pr" ? 42 : 4242}\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${fault === "missing" ? "" : f.candidate}\n`,
      );
      const result = runCorrection(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.read("events")).toBe("");
      expect(f.hosted()).toBe(f.source);
      expect(f.exists("prep.env")).toBe(false);
    },
  );

  it("refuses a malformed publication baseline before selecting a transport", () => {
    const f = fixture();
    const result = runCorrection(f, {
      setup: [
        "eval \"$(declare -f run_prepared_correction_review | sed '1s/run_prepared_correction_review/fixture_correction_review/')\"",
        "run_prepared_correction_review() {",
        '  if [ "$2" = publication-baseline ]; then',
        "    printf 'not-a-commit'; return 0",
        "  fi",
        '  fixture_correction_review "$@"',
        "}",
      ],
    });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.read("events")).toBe("");
    expect(f.hosted()).toBe(f.source);
    expect(f.exists("prepare-push-result.env")).toBe(false);
  });

  it.each([
    ["review", "printf '\\n' >> .local/correction-review.json"],
    ["other receipt", "cp .local/prepare-push-result.env .local/prepare-sync-result.env"],
    [
      "selected receipt",
      "LC_ALL=C sort -o .local/prepare-push-result.env .local/prepare-push-result.env",
    ],
    ["removed receipt", "rm .local/prepare-sync-result.env"],
  ])("rejects %s mutation while protected proof is running", (changed, duringProof) => {
    const f = fixture();
    if (changed === "removed receipt") {
      f.write(
        "prepare-sync-result.env",
        `PUSH_PREP_HEAD_SHA=${f.source}\nPUSH_LOCAL_PREP_HEAD_SHA=${f.source}\nPUSHED_FROM_SHA=${f.source}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${f.source}\n`,
      );
    }
    const result = runCorrection(f, { duringProof });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr).toContain("Correction review authority changed");
    expect(f.read("events")).toBe("graphql\nproof\n");
    expectIncomplete(f);
  });

  it.each(["writer failure", "replaced result"])(
    "does not advance authority or start proof after %s",
    (fault) => {
      const f = fixture();
      const result = runCorrection(f, {
        setup: [
          "eval \"$(declare -f pr_git | sed '1s/pr_git/fixture_git/')\"",
          "pr_git() {",
          fault === "writer failure"
            ? '  if [ "$*" = "hash-object --stdin" ]; then mkdir .local/prepare-push-result.env; fi'
            : '  if [ "$*" = "hash-object --no-filters -- .local/prepare-push-result.env" ]; then printf "\\n" >> .local/prepare-push-result.env; fi',
          '  fixture_git "$@"',
          "}",
        ],
        command: [
          "if prepare_push 4242; then exit 99; else status=$?; fi",
          `test "$PREP_PUBLICATION_LEASE_SHA" = '${f.source}' || exit 98`,
          'exit "$status"',
        ].join("\n"),
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(
        fault === "writer failure" ? "Is a directory" : "Correction review authority changed",
      );
      expect(f.read("events")).toBe("graphql\n");
      expectIncomplete(f);
    },
  );

  it("preserves an exact no-op receipt and advances stale process-local authority", () => {
    const f = fixture();
    const published = runCorrection(f);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const hosted = f.hosted();
    const receipt = f.read("prepare-push-result.env");
    const result = runCorrection(f, {
      command: [
        "source .local/prep-context.env",
        "PREP_PUBLICATION_PR=4242",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 4242)",
        `PREP_PUBLICATION_LEASE_SHA='${f.source}'`,
        `PREP_PUBLICATION_HEAD_SHA='${f.candidate}'`,
        `push_prep_head_to_pr_branch 4242 topic '${hosted}' '${hosted}' .local/prepare-push-result.env "$(pr_gh pr view 4242)"`,
        `test "$PREP_PUBLICATION_LEASE_SHA" = '${hosted}'`,
        `test "$PREP_PUBLICATION_HEAD_SHA" = '${hosted}'`,
        'verify_correction_review_snapshot 4242 "$PREP_PUBLICATION_REVIEW_SNAPSHOT"',
      ].join("\n"),
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(f.read("prepare-push-result.env")).toBe(receipt);
    expect(f.read("events")).toBe("graphql\nproof\n");
  });

  it("does not admit an unnamed result path", () => {
    const f = fixture();
    const unnamed = runCorrection(f, {
      command: [
        "source .local/prep-context.env",
        "PREP_PUBLICATION_REVIEW_SNAPSHOT=$(correction_review_snapshot 4242)",
        `push_prep_head_to_pr_branch 4242 topic '${f.candidate}' '${f.source}'`,
      ].join("\n"),
    });
    expect(unnamed.status, unnamed.stdout + unnamed.stderr).toBe(1);
    expect(unnamed.stderr).toContain("named preparation receipt");
    expect(f.read("events")).toBe("");
    expect(f.hosted()).toBe(f.source);
    expectIncomplete(f);
  });
});
