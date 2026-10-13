import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createPublisherRepoFactory, runPublisher } from "./pr-prepare.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const makePublisherRepo = createPublisherRepoFactory({
  cases: useAutoCleanupTempDirTracker(afterEach),
  templates,
});
const describePosix = process.platform === "win32" ? describe.skip : describe;
let signingKey: string;
let allowedSigners: string;

function fixture(transport: "auto" | "graphql" = "graphql", signLocal = transport === "auto") {
  const f = makePublisherRepo();
  // Metadata is native fixture state, never part of the reviewed candidate.
  appendFileSync(join(f.repoDir, ".git/info/exclude"), "\n.local/\n");
  f.env.OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH = "";
  f.env.OPENCLAW_PR_PUSH_MODE = transport;
  if (signLocal) {
    f.git("config", "gpg.format", "ssh");
    f.git("config", "user.signingKey", signingKey);
    f.git("config", "gpg.ssh.allowedSignersFile", allowedSigners);
    f.git("commit", "--amend", "-S", "--no-edit");
    f.candidate = f.git("rev-parse", "HEAD");
    f.git("verify-commit", f.candidate);
  }
  const metadata = { ...f.observation, baseRefOid: f.base, files: [{ path: "reviewed.txt" }] };
  writeFileSync(join(f.local, "pr-meta.json"), JSON.stringify(metadata));
  writeFileSync(join(f.local, "remote-observation.json"), JSON.stringify(metadata));
  const incoming = validReview(f.source);
  incoming.pr.number = 4242;
  incoming.issueValidation.status = "valid";
  incoming.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Incorrect publication behavior",
    area: "reviewed.txt",
    fix: "Preserve publication authority",
  });
  const incomingBytes = JSON.stringify(incoming);
  writeFileSync(join(f.local, "review.json"), incomingBytes);
  writeFileSync(join(f.local, "correction-incoming-review.json"), incomingBytes);
  const incomingOid = f.git("hash-object", "--no-filters", ".local/review.json");
  appendFileSync(
    join(f.local, "prep-context.env"),
    `PREP_REVIEW_MODE=correction\nPREP_INCOMING_JSON_OID=${incomingOid}\n`,
  );
  const reviewed = validReview(f.candidate);
  reviewed.pr.number = 4242;
  reviewed.recommendation = "READY FOR /prepare-pr";
  reviewed.issueValidation.status = "valid";
  writeFileSync(
    join(f.local, "correction-review.json"),
    JSON.stringify({
      ...reviewed,
      correction: {
        incomingHeadSha: f.source,
        incomingReviewJsonOid: incomingOid,
        resolvedFindings: [{ id: "I1", resolution: "The publication fix is reviewed." }],
      },
    }),
  );
  writeFileSync(
    join(f.local, "gates.env"),
    `PR_NUMBER=4242\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nREMOTE_GATES_PROVIDER=aws\n`,
  );
  return f;
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
  expect(existsSync(join(f.local, "prep.env"))).toBe(false);
  expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
    "GATES_MODE=remote_crabbox_aws_pending\n",
  );
  expect(readFileSync(join(f.local, "prep.md"), "utf8")).not.toContain("Gates passed");
}

describePosix("correction publication authority handoff", () => {
  beforeAll(() => {
    const root = templates.make("openclaw-correction-signing-");
    signingKey = join(root, "key");
    allowedSigners = join(root, "allowed-signers");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
    expect(generated.status, generated.stderr.toString()).toBe(0);
    writeFileSync(
      allowedSigners,
      `fixture@example.invalid ${readFileSync(`${signingKey}.pub`, "utf8")}`,
    );
  });

  it.each(["auto", "graphql"] as const)(
    "completes the first %s publication through protected-gate finalization",
    (transport) => {
      const f = fixture(transport);
      const before = readFileSync(join(f.local, "review.json"), "utf8");
      const result = runCorrection(f);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
      expect(hosted === f.candidate).toBe(transport === "auto");
      expect(f.git("rev-parse", `${hosted}^{tree}`)).toBe(f.git("rev-parse", "HEAD^{tree}"));
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe(
        `${transport === "auto" ? "push" : "graphql"}\nproof\n`,
      );
      expect(readFileSync(join(f.local, "prepare-push-result.env"), "utf8")).toContain(
        `PUSHED_FROM_SHA=${f.source}\n`,
      );
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `PREP_HEAD_SHA=${hosted}\n`,
      );
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `LOCAL_PREP_HEAD_SHA=${f.candidate}\n`,
      );
      expect(readFileSync(join(f.local, "gates.env"), "utf8")).toContain(
        `GATES_MODE=remote_crabbox_aws\nHOSTED_GATES_TARGET_HEAD_SHA=''\nLAST_VERIFIED_HEAD_SHA=${hosted}\nFULL_GATES_HEAD_SHA=${hosted}\n`,
      );
      expect(readFileSync(join(f.local, "review.json"), "utf8")).toBe(before);
      console.info(
        JSON.stringify({
          scenario: "owned publication",
          transport,
          status: result.status,
          hosted,
          local: f.candidate,
          publicationEvents: readFileSync(join(f.local, "events"), "utf8"),
        }),
      );
    },
  );

  it.each([
    ["auto", "prepare_push"],
    ["graphql", "prepare_push"],
    ["graphql", "prepare_sync_head"],
  ] as const)(
    "publishes and resumes a reviewed %s correction through %s with pending GitHub gates",
    (transport, command) => {
      const f = fixture(transport);
      const incomingReview = readFileSync(join(f.local, "review.json"), "utf8");
      writeFileSync(
        join(f.local, "gates.env"),
        `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.candidate}\n`,
      );
      const published = runCorrection(f, { command: `${command} 4242` });
      expect(published.status, published.stdout + published.stderr).toBe(0);
      const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
      const gates = readFileSync(join(f.local, "gates.env"), "utf8");
      expect(gates).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${hosted}\n`);
      expect(gates).not.toMatch(/GATES_PASSED_AT|LAST_VERIFIED_HEAD_SHA|FULL_GATES_HEAD_SHA/);
      expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(
        `LOCAL_PREP_HEAD_SHA=${f.candidate}\n`,
      );
      expect(readFileSync(join(f.local, "prep.md"), "utf8")).not.toContain("Gates passed");
      const resumed = runCorrection(f);
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(readFileSync(join(f.local, "gates.env"), "utf8")).toBe(gates);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe(
        `${transport === "auto" ? "push" : "graphql"}\n`,
      );
      expect(readFileSync(join(f.local, "review.json"), "utf8")).toBe(incomingReview);
    },
  );

  it.each(
    (["auto", "graphql"] as const).flatMap((transport) =>
      (["foreign receipt", "withdrawn", "reassigned"] as const).map((fault) => ({
        transport,
        fault,
      })),
    ),
  )(
    "refuses $fault authority after $transport planning before any publication I/O",
    ({ transport, fault }) => {
      const f = fixture(transport);
      const result = runCorrection(f, {
        setup: [
          "eval \"$(declare -f pr_git | sed '1s/pr_git/fixture_git/')\"",
          "pr_git() {",
          '  if [ "$1" = verify-commit ] || [ "$*" = "log -1 --format=%b HEAD" ]; then',
          "    echo planned > .local/authority-changed",
          fault === "foreign receipt"
            ? `    printf 'PUSH_PREP_HEAD_SHA=${f.sameTree}\\nPUSH_LOCAL_PREP_HEAD_SHA=${f.sameTree}\\nPUSHED_FROM_SHA=${f.source}\\nPUSH_REPLACED_HOSTED_ANCESTRY=false\\nPR_HEAD_SHA_AFTER_PUSH=${f.sameTree}\\n' > .local/prepare-push-result.env`
            : `    jq '${fault === "withdrawn" ? '.state = "CLOSED"' : '.headRepository.nameWithOwner = "replacement/repo"'}' .local/remote-observation.json > .local/changed-observation.json`,
          ...(fault === "foreign receipt"
            ? []
            : ["    mv .local/changed-observation.json .local/remote-observation.json"]),
          "  fi",
          '  fixture_git "$@"',
          "}",
        ],
      });
      expect(existsSync(join(f.local, "authority-changed"))).toBe(true);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      const refusal =
        fault === "foreign receipt" ? "Correction review authority changed" : "PR identity changed";
      expect(result.stdout + result.stderr).toContain(refusal);
      const events = readFileSync(join(f.local, "events"), "utf8");
      expect(events).toBe("");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
      console.info(
        JSON.stringify({
          scenario: fault,
          transport,
          status: result.status,
          refusal,
          publicationEvents: events,
          remoteUnchanged: true,
        }),
      );
    },
  );

  it.each(["missing", "stale", "foreign-pr", "changed-review"])(
    "refuses pending correction publication with %s binding",
    (fault) => {
      const f = fixture();
      writeFileSync(
        join(f.local, "gates.env"),
        `PR_NUMBER=${fault === "foreign-pr" ? 42 : 4242}\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${fault === "missing" ? "" : fault === "stale" ? f.source : f.candidate}\n`,
      );
      if (fault === "changed-review") {
        const path = join(f.local, "correction-review.json");
        const review = JSON.parse(readFileSync(path, "utf8"));
        review.pr.headSha = f.source;
        writeFileSync(path, JSON.stringify(review));
      }
      const result = runCorrection(f);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
      expect(existsSync(join(f.local, "prep.env"))).toBe(false);
    },
  );

  it("publishes a signed baseline refresh only after fresh exact-candidate review and gates", () => {
    const f = fixture("auto");
    f.git("branch", "-m", "pr-4242-prep");
    const contextPath = join(f.local, "prep-context.env");
    writeFileSync(
      contextPath,
      readFileSync(contextPath, "utf8").replace("PREP_BRANCH=prep", "PREP_BRANCH=pr-4242-prep"),
    );
    const oldGates = readFileSync(join(f.local, "gates.env"));
    f.git("checkout", "-q", "-b", "baseline", f.base);
    writeFileSync(join(f.repoDir, "upstream.txt"), "upstream baseline repair\n");
    f.git("add", "upstream.txt");
    f.git("commit", "-qm", "fix: upstream baseline");
    const baseline = f.git("rev-parse", "HEAD");
    f.git("checkout", "-q", "pr-4242-prep");
    const refreshed = runCorrection(f, {
      command: `prepare_baseline_refresh 4242 --expected-head ${f.candidate} --baseline ${baseline}`,
      setup: [
        'source "$script_parent_dir/pr-lib/operation-lock.sh"',
        "mark_pr_operation_side_effects_started() { :; }",
        `enter_worktree() { PR_MAIN_SHA=${baseline}; }`,
        "PR_OPERATION_LOCK_REF=refs/openclaw/pr-operation-locks/4242",
        `PR_OPERATION_LOCK_OWNER_OID=${f.source}`,
        'git update-ref "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID"',
      ],
    });
    expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
    const head = f.git("rev-parse", "HEAD");
    const initialized = runCorrection(f, { command: "prepare_correction_review_init 4242" });
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
    const reviewPath = join(f.local, "correction-review.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    Object.assign(review, validReview(head));
    review.pr.number = 4242;
    review.recommendation = "READY FOR /prepare-pr";
    review.issueValidation.status = "valid";
    review.correction.resolvedFindings[0].resolution = "Reviewed the full refreshed product delta.";
    writeFileSync(reviewPath, JSON.stringify(review));
    writeFileSync(join(f.local, "gates.env"), oldGates);
    const stale = runCorrection(f);
    expect(stale.status).not.toBe(0);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
    expect(readFileSync(join(f.local, "events"), "utf8")).not.toContain("push");
    writeFileSync(
      join(f.local, "gates.env"),
      `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${head}\nFULL_GATES_HEAD_SHA=${head}\n`,
    );
    const published = runCorrection(f);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(head);
    expect(f.git("show", "-s", "--format=%P", head)).toBe(`${f.candidate} ${baseline}`);
    f.git("verify-commit", head);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("push\n");
    expect(readFileSync(join(f.local, "prepare-push-result.env"), "utf8")).toContain(
      `PUSH_LOCAL_PREP_HEAD_SHA=${head}\n`,
    );
    const originalNames = ["pr-meta.json", "pr-meta.env", "review.json"];
    for (const name of originalNames) {
      writeFileSync(join(f.local, `original-${name}`), readFileSync(join(f.local, name)));
    }
    const retainedContext = readFileSync(contextPath);
    const retainedBinding = readFileSync(join(f.local, "prepare-baseline.json"));
    const observed = runCorrection(f, {
      command: "review_init 4242; review_checkout_pr 4242; review_artifacts_init 4242",
      setup: ["pr_meta_json() { pr_gh pr view 4242; }"],
    });
    expect(observed.status, observed.stdout + observed.stderr).toBe(0);
    f.git("checkout", "-q", "pr-4242-prep");
    writeFileSync(join(f.repoDir, "ci-fix.txt"), "CI correction after baseline publication\n");
    f.git("add", "ci-fix.txt");
    f.git("commit", "-S", "-qm", "fix: baseline CI follow-up");
    const followup = f.git("rev-parse", "HEAD");
    const priorReview = readFileSync(reviewPath);
    const liveMetadata = readFileSync(join(f.local, "pr-meta.json"));
    const recovery =
      "prepare_correction_review_init 4242 --recover-incoming " +
      originalNames.map((name) => `.local/original-${name}`).join(" ");
    // Backups alone are not authority: exact signed digests and history must replay.
    appendFileSync(join(f.local, "original-pr-meta.json"), "\n");
    expect(runCorrection(f, { command: recovery }).status).not.toBe(0);
    expect(readFileSync(reviewPath)).toEqual(priorReview);
    expect(existsSync(join(f.local, "correction-incoming-meta.json"))).toBe(false);
    writeFileSync(
      join(f.local, "original-pr-meta.json"),
      readFileSync(join(f.local, "original-pr-meta.json")).subarray(0, -1),
    );
    const recovered = runCorrection(f, { command: recovery });
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    const correction = JSON.parse(readFileSync(reviewPath, "utf8"));
    expect(correction.pr.headSha).toBe(followup);
    expect(correction.recommendation).toBe("NEEDS WORK");
    expect(correction.correction.resolvedFindings).toEqual([{ id: "I1", resolution: "" }]);
    Object.assign(correction, validReview(followup));
    correction.pr.number = 4242;
    correction.recommendation = "READY FOR /prepare-pr";
    correction.issueValidation.status = "valid";
    correction.correction.resolvedFindings[0].resolution =
      "Reviewed original scope and the CI fix.";
    writeFileSync(reviewPath, JSON.stringify(correction));
    const valid = runCorrection(f, { command: "require_prepared_review 4242" });
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    expect(readFileSync(contextPath)).toEqual(retainedContext);
    expect(readFileSync(join(f.local, "prepare-baseline.json"))).toEqual(retainedBinding);
    expect(readFileSync(join(f.local, "pr-meta.json"))).toEqual(liveMetadata);
    expect(f.git("rev-parse", "HEAD")).toBe(followup);
  });

  it.each(["auto", "graphql"] as const)(
    "keeps original admission through a %s hosted review round",
    (transport) => {
      const f = fixture(transport, true);
      const originalReview = readFileSync(join(f.local, "review.json"));
      const originalMetadata = readFileSync(join(f.local, "pr-meta.json"));
      const originalEnvironment = readFileSync(join(f.local, "pr-meta.env"));
      // The immutable inputs are normally captured by prepare-correction-init.
      writeFileSync(join(f.local, "correction-incoming-meta.json"), originalMetadata);
      writeFileSync(join(f.local, "correction-incoming-meta.env"), originalEnvironment);
      writeFileSync(join(f.local, "correction-original-review.json"), originalReview);
      appendFileSync(
        join(f.local, "prep-context.env"),
        `PREP_INCOMING_META_OID=${f.git("hash-object", ".local/pr-meta.json")}\nPREP_INCOMING_ENV_OID=${f.git("hash-object", ".local/pr-meta.env")}\n`,
      );
      const context = readFileSync(join(f.local, "prep-context.env"));
      writeFileSync(
        join(f.local, "gates.env"),
        `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.candidate}\n`,
      );
      const published = runCorrection(f);
      expect(published.status, published.stdout + published.stderr).toBe(0);
      const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
      const initialized = runCorrection(f, {
        command: "review_init 4242; review_checkout_pr 4242; review_artifacts_init 4242",
        setup: ["pr_meta_json() { pr_gh pr view 4242; }"],
      });
      expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
      const hostedMetadata = readFileSync(join(f.local, "pr-meta.json"));
      f.git("checkout", "-q", "prep");
      const noOpInit = runCorrection(f, { command: "prepare_correction_review_init 4242" });
      expect(noOpInit.status, noOpInit.stdout + noOpInit.stderr).toBe(0);
      const noOpPath = join(f.local, "correction-review.json");
      const noOpReview = JSON.parse(readFileSync(noOpPath, "utf8"));
      Object.assign(noOpReview, validReview(f.candidate));
      noOpReview.pr.number = 4242;
      noOpReview.recommendation = "READY FOR /prepare-pr";
      noOpReview.issueValidation.status = "valid";
      noOpReview.correction.resolvedFindings[0].resolution =
        "Reviewed exact unchanged publication.";
      writeFileSync(noOpPath, JSON.stringify(noOpReview));
      const noOp = runCorrection(f);
      expect(noOp.status, noOp.stdout + noOp.stderr).toBe(0);
      expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(hosted);
      const publishedReview = validReview(hosted);
      publishedReview.pr.number = 4242;
      publishedReview.issueValidation.status = "valid";
      publishedReview.findings.push({
        id: "I1",
        severity: "IMPORTANT",
        title: "CI follow-up",
        area: "reviewed.txt",
        fix: "Repair current CI",
      });
      writeFileSync(join(f.local, "review.json"), JSON.stringify(publishedReview));
      const hostedReview = readFileSync(join(f.local, "review.json"));
      expect(JSON.parse(hostedMetadata.toString()).headRefOid).toBe(hosted);
      f.git("checkout", "-q", "prep");
      if (transport === "graphql") {
        f.git("config", "gpg.format", "ssh");
        f.git("config", "user.signingKey", signingKey);
        f.git("config", "gpg.ssh.allowedSignersFile", allowedSigners);
        // Preserve both the reviewed local commit and its verified hosted alias.
        f.git("merge", "--no-ff", "-S", "-m", "retain hosted publication", hosted);
      }
      writeFileSync(join(f.repoDir, "ci-fix.txt"), "a real follow-up delta\n");
      f.git("add", "ci-fix.txt");
      f.git("commit", "-S", "-qm", "fix: CI follow-up");
      const followup = f.git("rev-parse", "HEAD");
      const receiptPath = join(f.local, "prepare-push-result.env");
      const receipt = readFileSync(receiptPath);
      rmSync(receiptPath);
      expect(runCorrection(f, { command: "prepare_correction_review_init 4242" }).status).not.toBe(
        0,
      );
      expect(f.git("rev-parse", "prep")).toBe(followup);
      writeFileSync(receiptPath, receipt);
      const foreignMeta = { ...JSON.parse(hostedMetadata.toString()), headRefOid: f.advance };
      writeFileSync(join(f.local, "pr-meta.json"), JSON.stringify(foreignMeta));
      const refused = runCorrection(f, { command: "refresh_prep_branch_for_reviewed_head 4242" });
      expect(refused.status).not.toBe(0);
      expect(f.git("rev-parse", "prep")).toBe(followup);
      expect(readFileSync(join(f.local, "prep-context.env"))).toEqual(context);
      writeFileSync(join(f.local, "pr-meta.json"), hostedMetadata);
      const correction = runCorrection(f, { command: "prepare_correction_review_init 4242" });
      expect(correction.status, correction.stdout + correction.stderr).toBe(0);
      const reviewPath = join(f.local, "correction-review.json");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      expect(review.pr.headSha).toBe(followup);
      expect(review.correction.incomingHeadSha).toBe(f.source);
      expect(review.correction.resolvedFindings).toEqual([{ id: "I1", resolution: "" }]);
      // An unfinished fresh review and old gates cannot publish the new head.
      expect(runCorrection(f).status).not.toBe(0);
      Object.assign(review, validReview(followup));
      review.pr.number = 4242;
      review.recommendation = "READY FOR /prepare-pr";
      review.issueValidation.status = "valid";
      review.correction.resolvedFindings[0].resolution = "Independently reviewed full follow-up.";
      writeFileSync(reviewPath, JSON.stringify(review));
      const unresolved = runCorrection(f, { command: "require_prepared_review 4242" });
      expect(unresolved.status).not.toBe(0);
      expect(unresolved.stderr).toContain("published review findings");
      review.correction.publishedReview.resolvedFindings[0].resolution =
        "Independently reviewed the hosted CI finding too.";
      writeFileSync(reviewPath, JSON.stringify(review));
      appendFileSync(join(f.local, "review.json"), "\n");
      expect(runCorrection(f, { command: "require_prepared_review 4242" }).status).not.toBe(0);
      writeFileSync(join(f.local, "review.json"), hostedReview);
      writeFileSync(
        join(f.local, "gates.env"),
        `PR_NUMBER=4242\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${followup}\n`,
      );
      const synced = runCorrection(f);
      expect(synced.status, synced.stdout + synced.stderr).toBe(0);
      const nextHosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
      expect(f.git("rev-parse", `${nextHosted}^{tree}`)).toBe(
        f.git("rev-parse", `${followup}^{tree}`),
      );
      expect(f.git("rev-parse", "prep")).toBe(followup);
      expect(readFileSync(join(f.local, "prep-context.env"))).toEqual(context);
      expect(readFileSync(join(f.local, "pr-meta.json"))).toEqual(hostedMetadata);
      expect(readFileSync(join(f.local, "review.json"))).toEqual(hostedReview);
      expect(readFileSync(join(f.local, "correction-incoming-review.json"))).toEqual(
        originalReview,
      );
      expect(readFileSync(join(f.local, "prepare-push-result.env"), "utf8")).toContain(
        `PUSHED_FROM_SHA=${hosted}\n`,
      );
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe(
        transport === "auto" ? "push\npush\n" : "graphql\npush\n",
      );
      console.info(
        JSON.stringify({
          scenario: "hosted review continuation",
          transport,
          status: synced.status,
          original: f.source,
          hosted,
          followup,
          nextHosted,
          publicationEvents: readFileSync(join(f.local, "events"), "utf8"),
        }),
      );
    },
  );

  it.each(["review", "other receipt", "selected receipt", "removed receipt"])(
    "rejects %s mutation while protected proof is running",
    (changed) => {
      const f = fixture();
      if (changed === "removed receipt") {
        writeFileSync(
          join(f.local, "prepare-sync-result.env"),
          `PUSH_PREP_HEAD_SHA=${f.source}\nPUSH_LOCAL_PREP_HEAD_SHA=${f.source}\nPUSHED_FROM_SHA=${f.source}\nPUSH_REPLACED_HOSTED_ANCESTRY=false\nPR_HEAD_SHA_AFTER_PUSH=${f.source}\n`,
        );
      }
      const path =
        changed === "review"
          ? ".local/correction-review.json"
          : changed === "other receipt"
            ? ".local/prepare-sync-result.env"
            : ".local/prepare-push-result.env";
      const result = runCorrection(f, {
        duringProof:
          changed === "removed receipt"
            ? "rm .local/prepare-sync-result.env"
            : changed === "other receipt"
              ? `cp .local/prepare-push-result.env ${path}`
              : changed === "selected receipt"
                ? `LC_ALL=C sort -o "${path}" "${path}"`
                : `printf '\\n' >> ${path}`,
      });
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Correction review authority changed");
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\nproof\n");
      expectIncomplete(f);
    },
  );

  it("admits the named sync receipt with completed correction gates", () => {
    const f = fixture();
    writeFileSync(
      join(f.local, "gates.env"),
      `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${f.candidate}\nFULL_GATES_HEAD_SHA=${f.candidate}\n`,
    );
    const result = runCorrection(f, { command: "prepare_sync_head 4242" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
    expect(readFileSync(join(f.local, "prepare-sync-result.env"), "utf8")).toContain(
      `PUSH_PREP_HEAD_SHA=${hosted}\n`,
    );
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(`PREP_HEAD_SHA=${hosted}\n`);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
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
      expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\n");
      expectIncomplete(f);
    },
  );

  it("preserves an exact no-op receipt and advances stale process-local authority", () => {
    const f = fixture();
    const published = runCorrection(f);
    expect(published.status, published.stdout + published.stderr).toBe(0);
    const hosted = f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic");
    const resultPath = join(f.local, "prepare-push-result.env");
    const receipt = readFileSync(resultPath, "utf8");
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
    expect(readFileSync(resultPath, "utf8")).toBe(receipt);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("graphql\nproof\n");
  });

  it("does not admit an unnamed result path or pending sync publication", () => {
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
    const sync = runCorrection(f, { command: "prepare_sync_head 4242" });
    expect(sync.status, sync.stdout + sync.stderr).toBe(1);
    expect(readFileSync(join(f.local, "events"), "utf8")).toBe("");
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/topic")).toBe(f.source);
    expectIncomplete(f);
  });
});
