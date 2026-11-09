import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBaselineFixture,
  reuseBaselineFixture,
  failRestore,
} from "./pr-baseline-native.test-support.js";
import { validReview } from "./pr-review-artifact-fixture.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;
const flags = (values: Record<string, string>) => Object.entries(values).flat();
const command = "prepare-baseline-refresh";
const fixture = reuseBaselineFixture((root) => {
  const f = createBaselineFixture(root, 1);
  const binding = f.git(f.repo, "rev-parse", "refs/openclaw/pr-workflow-bindings/42");
  let workflow = JSON.parse(f.git(f.repo, "show", binding + ":binding.json")).source as string;
  const oid = (name: string) => f.prepGit("hash-object", "--no-filters", f.local(name));
  const proofReview = (head: string, incoming: string, incomingReview: string) => {
    const review = validReview(head);
    review.recommendation = "NEEDS WORK";
    review.issueValidation.status = "valid";
    review.findings = [
      {
        id: "I1",
        severity: "IMPORTANT",
        title: "Published package proof remains",
        area: f.product[0]!,
        fix: "Retain exact package proof",
      },
    ];
    return {
      ...review,
      correction: {
        incomingHeadSha: incoming,
        incomingReviewJsonOid: incomingReview,
        resolvedFindings: [{ id: "I1", resolution: "" }],
        proofPublication: {
          version: 1,
          kind: "published-candidate-proof",
          headSha: head,
          treeOid: f.prepGit("rev-parse", head + "^{tree}"),
          workflowSource: workflow,
          workflowBinding: binding,
          expectedHostedHead: incoming,
          pendingFindings: [{ id: "I1", evidence: "Exact published package proof is required." }],
        },
      },
    };
  };
  const published = f.prepGit("rev-parse", "HEAD");
  f.writeLocal(
    "correction-review.json",
    JSON.stringify(proofReview(published, f.incoming, oid("review.json"))),
  );
  f.git(f.repo, "config", "url." + f.repo + ".insteadOf", "https://github.com/fixture/repo.git");
  f.pass("prepare-publish-for-proof");
  expect(f.git(f.repo, "rev-parse", "topic")).toBe(published);
  expect(f.readLocal("prepare-push-result.env").toString()).toContain("PUSH_PURPOSE=proof");
  const foreignKey = join(root, "main-signer");
  expect(
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", foreignKey], { env: f.env })
      .status,
  ).toBe(0);
  f.git(
    f.repo,
    "-c",
    "user.signingKey=" + foreignKey,
    "commit",
    "--allow-empty",
    "-qm",
    "test: independently signed canonical main",
  );
  const baseline = f.git(f.repo, "rev-parse", "HEAD");
  // The explicit producer is a current-official-main operation, not an edit of
  // the older retained workflow binding or an unlanded wrapper opt-in.
  workflow = baseline;
  f.git(
    f.repo,
    "config",
    "--add",
    "url." + f.repo + "/.insteadOf",
    "https://github.com/openclaw/openclaw.git",
  );
  f.git(f.repo, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
  f.git(f.repo, "fetch", "-q", "origin", "main");

  const signature = spawnSync("git", ["verify-commit", baseline], {
    cwd: f.worktree,
    env: f.env,
    encoding: "utf8",
  });
  expect(signature.status).not.toBe(0);
  expect(signature.stderr).toContain('Good "git" signature');
  expect(signature.stderr).toContain("No principal matched");
  f.prepGit(
    "merge",
    "--no-ff",
    "-qm",
    "test: ordinary signed merge without baseline marker\n\nCo-authored-by: Ada Example <ada@example.invalid>",
    baseline,
  );
  const source = f.prepGit("rev-parse", "HEAD");
  const tree = f.prepGit("rev-parse", "HEAD^{tree}");
  expect(f.prepGit("show", "-s", "--format=%P", source)).toBe(published + " " + baseline);
  const fresh = validReview(published);
  fresh.recommendation = "NEEDS WORK";
  fresh.issueValidation.status = "valid";
  fresh.findings = [
    {
      id: "I1",
      severity: "IMPORTANT",
      title: "Required package proof remains",
      area: f.product[0]!,
      fix: "Obtain the proof",
    },
  ];
  // External incoming-review artifacts are fresh; native preparation and its
  // real publication receipt deliberately remain bound to the original A.
  f.writeLocal("review.json", JSON.stringify(fresh));
  f.writeLocal("pr-meta.json", JSON.stringify({ ...f.meta, headRefOid: published }));
  f.writeLocal(
    "pr-meta.env",
    "PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=" +
      published +
      "\nPR_HEAD_REPO_URL=https://github.com/fixture/repo\n",
  );
  const review = proofReview(source, published, oid("review.json"));
  f.writeLocal("source-review.json", JSON.stringify(review));
  const continuation = flags({
    "--expected-head": source,
    "--expected-tree": tree,
    "--incoming-head": published,
    "--incoming-review": oid("review.json"),
    "--publication-receipt": "push",
    "--publication-oid": oid("prepare-push-result.env"),
  });
  const args = [
    "--for-proof",
    "--baseline",
    baseline,
    "--source-review",
    f.local("source-review.json"),
    "--expected-review",
    oid("source-review.json"),
    ...continuation,
  ];
  const effects = f.local("effects");
  const proxy = f.local("observed-git");
  writeFileSync(
    proxy,
    '#!/bin/sh\nif [ "$1" = push ]; then echo push >> "' + effects + '"; fi\nexec git "$@"\n',
    { mode: 0o755 },
  );
  const gh = join(root, "bin/gh");
  writeFileSync(
    gh,
    readFileSync(gh, "utf8").replace(
      "const args = process.argv.slice(2);",
      "const args = process.argv.slice(2);\nif (args[0] === 'api' && args[1] === 'graphql' && !args.some(a => a.startsWith('query=query('))) fs.appendFileSync(" +
        JSON.stringify(effects) +
        ", 'graphql\\n');",
    ),
  );
  const before = f.snapshot([
    "prep-context.env",
    "review.json",
    "correction-review.json",
    "correction-incoming-review.json",
    "prepare-push-result.env",
  ]);
  return {
    ...f,
    binding,
    workflow,
    oid,
    proofReview,
    published,
    baseline,
    source,
    tree,
    review,
    args,
    continuation,
    effects,
    before,
    extra: { OPENCLAW_PR_GIT: proxy },
  };
});

const directFixture = reuseBaselineFixture((root) => createBaselineFixture(root, 1));

function nativeState(f: ReturnType<typeof fixture>) {
  return {
    preparedHead: f.prepGit("rev-parse", "HEAD"),
    indexTree: f.prepGit("write-tree"),
    hostedHead: f.git(f.repo, "rev-parse", "topic"),
    files: Object.fromEntries(
      [
        "prep-context.env",
        "prepare-baseline.json",
        "review-transition.json",
        "prep.env",
        "gates.env",
        "correction-review.json",
        "prepare-push-result.env",
      ].map((name) => [name, existsSync(f.local(name)) ? f.oid(name) : null]),
    ),
    effects: existsSync(f.effects)
      ? readFileSync(f.effects, "utf8").trim().split(/\r?\n/u).filter(Boolean)
      : [],
  };
}

function replaceCustodyAfterObservation(f: ReturnType<typeof fixture>, marker: string) {
  const gh = join(f.root, "bin/gh");
  const injected = `const args = process.argv.slice(2);
if (args.some(a => a === 'repos/fixture/repo/pulls/42') && !fs.existsSync(${JSON.stringify(marker)})) {
  const ref = 'refs/openclaw/pr-operation-locks/42';
  const held = cp.spawnSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', ref], {encoding:'utf8'});
  if (held.status === 0 && git('cat-file', '-t', held.stdout.trim()) === 'blob') {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({previousOwner:held.stdout.trim(),objectType:'blob'}));
    git('update-ref', ref, ${JSON.stringify(f.source)}, held.stdout.trim());
  }
}`;
  writeFileSync(
    gh,
    readFileSync(gh, "utf8").replace("const args = process.argv.slice(2);", injected),
  );
}

function nativeTrace(
  f: ReturnType<typeof fixture>,
  scenario: string,
  before: ReturnType<typeof nativeState>,
  result: ReturnType<ReturnType<typeof fixture>["run"]>,
  expectedPushes: number,
) {
  const canary = "SYNTHETIC_NATIVE_PROOF_SECRET_CANARY";
  const redact = (text: string) =>
    text
      .replaceAll(f.root, "<fixture>")
      .replaceAll(process.cwd(), "<implementation>")
      .replaceAll(canary, "<redacted-canary>")
      .replace(/SHA256:[A-Za-z0-9+/]+/gu, "<redacted-fingerprint>");
  expect(redact(f.root + "/key " + canary)).toBe("<fixture>/key <redacted-canary>");
  const after = nativeState(f);
  expect(after.effects.filter((effect) => effect === "push")).toHaveLength(expectedPushes);
  expect(after.effects.filter((effect) => effect === "graphql")).toHaveLength(0);
  const record = JSON.stringify({
    scenario,
    adapter: "synthetic GitHub; real native wrapper and local Git remote",
    ownerBlob: f.prepGit("rev-parse", "HEAD:scripts/pr-lib/baseline-refresh.mjs"),
    before,
    after,
    expectedPushes,
    exitCode: result.status,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  });
  expect(record).not.toContain(canary);
  expect(record).not.toMatch(/-----BEGIN [^-]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20}|oauth_token/gu);
  console.info("NATIVE_AUTHORITY_TRACE " + record);
}

describePosix("proof baseline from the retained publication lifecycle", () => {
  it("refuses both old routes, creates a descendant, then publishes only with new exact-candidate proof review", () => {
    const f = fixture();
    const ordinary = f.run("prepare-correction-continue", f.continuation, f.extra);
    expect(ordinary.status).not.toBe(0);
    expect(ordinary.stdout + ordinary.stderr).toContain("No principal matched");
    expect(
      f.run(command, ["--expected-head", f.source, "--baseline", f.baseline], f.extra).status,
    ).not.toBe(0);
    f.expectSnapshot(f.before);
    f.writeLocal(
      "coauthors.json",
      JSON.stringify([
        "Ada Example <ada@example.invalid>",
        "Renée Example <renee@example.invalid>",
        "Renée Example <RENEE@example.invalid>",
      ]),
    );
    mkdirSync(join(f.repo, ".local"), { recursive: true });
    writeFileSync(join(f.repo, ".local/coauthors.json"), "{}");
    const args = [...f.args, "--coauthors", ".local/coauthors.json"];
    const beforeAdmission = nativeState(f);
    const result = spawnSync(join(f.repo, "scripts/pr"), [command, "42", ...args], {
      cwd: f.worktree,
      env: { ...f.env, ...f.extra },
      encoding: "utf8",
    });
    nativeTrace(f, "allowed-proof-baseline-admission", beforeAdmission, result, 0);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const candidate = f.prepGit("rev-parse", "HEAD");
    expect(candidate).not.toBe(f.source);
    expect(f.prepGit("rev-parse", "HEAD^{tree}")).toBe(f.tree);
    expect(f.prepGit("show", "-s", "--format=%P", candidate)).toBe(f.source + " " + f.baseline);
    f.prepGit("merge-base", "--is-ancestor", f.published, candidate);
    f.prepGit("verify-commit", candidate);
    const binding = JSON.parse(f.readLocal("prepare-baseline.json").toString());
    expect(f.prepGit("show", "-s", "--format=%B", candidate)).toBe(
      [
        "fix: refresh the reviewed correction baseline",
        "",
        "Baseline-Refresh: " + f.oid("prepare-baseline.json"),
        "Co-authored-by: Ada Example <ada@example.invalid>",
        "Co-authored-by: Renée Example <renee@example.invalid>",
      ].join("\n"),
    );
    expect(binding.coauthors).toEqual([
      "Ada Example <ada@example.invalid>",
      "Renée Example <renee@example.invalid>",
    ]);
    expect(binding).toMatchObject({
      version: 2,
      purpose: "proof",
      sourceHead: f.source,
      baselineHead: f.baseline,
      incomingHead: f.published,
      proofSource: {
        sourceTree: f.tree,
        sourceReviewOid: f.oid("source-review.json"),
        workflowSource: f.workflow,
        workflowBinding: f.binding,
      },
    });
    expect(f.readLocal("review.json")).toEqual(f.before["review.json"]);
    for (const name of ["gates.env", "prep.env", "review-transition.json"]) {
      expect(existsSync(f.local(name)), name).toBe(false);
    }
    expect(existsSync(f.effects)).toBe(false);
    const initialized = JSON.parse(f.readLocal("correction-review.json").toString());
    expect(initialized.pr.headSha).toBe(candidate);
    expect(initialized.correction.proofPublication).toBeUndefined();
    // An M review cannot approve C; forged gate success cannot change that.
    f.writeLocal("correction-review.json", f.readLocal("source-review.json"));
    expect(f.run("prepare-publish-for-proof", [], f.extra).status).not.toBe(0);

    f.writeLocal(
      "correction-review.json",
      JSON.stringify(f.proofReview(candidate, f.published, f.oid("review.json"))),
    );
    const successor = f.run(
      "prepare-workflow-successor",
      [
        ...flags({
          "--expected-binding": f.binding,
          "--from-workflow": JSON.parse(f.git(f.repo, "show", f.binding + ":binding.json"))
            .source as string,
          "--to-workflow": f.workflow,
          "--expected-head": candidate,
          "--expected-tree": f.tree,
          "--expected-review": f.oid("correction-review.json"),
          "--expected-hosted-head": f.published,
        }),
        "--for-proof",
      ],
      f.extra,
    );
    expect(successor.status, successor.stdout + successor.stderr).toBe(0);
    for (const denied of ["prepare-gates", "prepare-push", "prepare-sync-head", "merge-verify"]) {
      f.preparePublication();
      expect(f.run(denied, [], f.extra).status, denied).not.toBe(0);
      expect(existsSync(f.effects)).toBe(false);
    }
    const beforePublication = nativeState(f);
    const pushed = f.run("prepare-publish-for-proof", [], f.extra);
    nativeTrace(f, "allowed-exact-candidate-publication", beforePublication, pushed, 1);
    expect(pushed.status, pushed.stdout + pushed.stderr).toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(candidate);
    expect(readFileSync(f.effects, "utf8")).toBe("push\n");
    expect(f.readLocal("prepare-push-result.env").toString()).toContain("PUSH_PURPOSE=proof");
    expect(f.readLocal("correction-review.json").toString()).toContain(
      '"recommendation":"NEEDS WORK"',
    );
    expect(existsSync(f.local("prep.env"))).toBe(false);
    // A later native continuation reads historical source admission from its
    // archive, never from the newly active incoming metadata or review.
    writeFileSync(join(f.worktree, f.product[0]!), "later correction\n");
    f.prepGit("commit", "-qam", "fix: later independently reviewed correction");
    const descendant = f.prepGit("rev-parse", "HEAD");
    const incomingReview = validReview(candidate);
    incomingReview.recommendation = "NEEDS WORK";
    incomingReview.issueValidation.status = "valid";
    incomingReview.findings = [
      {
        id: "I1",
        severity: "IMPORTANT",
        title: "Later proof remains",
        area: f.product[0]!,
        fix: "Retain proof",
      },
    ];
    f.writeLocal("review.json", JSON.stringify(incomingReview));
    f.writeLocal("pr-meta.json", JSON.stringify({ ...f.meta, headRefOid: candidate }));
    f.writeLocal(
      "pr-meta.env",
      "PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=" +
        candidate +
        "\nPR_HEAD_REPO_URL=https://github.com/fixture/repo\n",
    );
    const continued = f.run(
      "prepare-correction-continue",
      flags({
        "--expected-head": descendant,
        "--expected-tree": f.prepGit("rev-parse", "HEAD^{tree}"),
        "--incoming-head": candidate,
        "--incoming-review": f.oid("review.json"),
        "--publication-receipt": "push",
        "--publication-oid": f.oid("prepare-push-result.env"),
      }),
      f.extra,
    );
    expect(continued.status, continued.stdout + continued.stderr).toBe(0);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(descendant);
    expect(readFileSync(f.effects, "utf8")).toBe("push\n");
  });

  it("also admits the current incoming context without inventing publication lineage", () => {
    const f = directFixture();
    const source = f.prepGit("rev-parse", "HEAD");
    const tree = f.prepGit("rev-parse", "HEAD^{tree}");
    const binding = f.git(f.repo, "rev-parse", "refs/openclaw/pr-workflow-bindings/42");
    f.git(f.repo, "commit", "--allow-empty", "-qm", "test: current canonical workflow");
    const baseline = f.git(f.repo, "rev-parse", "HEAD");
    f.git(
      f.repo,
      "config",
      "url." + f.repo + ".insteadOf",
      "https://github.com/openclaw/openclaw.git",
    );
    f.git(f.repo, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
    f.git(f.repo, "fetch", "-q", "origin", "main");
    const review = JSON.parse(f.readLocal("correction-review.json").toString());
    review.recommendation = "NEEDS WORK";
    review.correction.resolvedFindings[0].resolution = "";
    review.findings = [
      {
        id: "I1",
        severity: "IMPORTANT",
        title: "Required proof remains",
        area: f.product[0]!,
        fix: "Obtain published proof",
      },
    ];
    review.correction.proofPublication = {
      version: 1,
      kind: "published-candidate-proof",
      headSha: source,
      treeOid: tree,
      workflowSource: baseline,
      workflowBinding: binding,
      expectedHostedHead: f.incoming,
      pendingFindings: [{ id: "I1", evidence: "Observe the exact published package." }],
    };
    f.writeLocal("correction-review.json", JSON.stringify(review));
    const incoming = f.readLocal("review.json");
    const result = f.run(command, [
      "--for-proof",
      ...flags({
        "--expected-head": source,
        "--expected-tree": tree,
        "--expected-review": f.prepGit(
          "hash-object",
          "--no-filters",
          f.local("correction-review.json"),
        ),
        "--baseline": baseline,
      }),
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const record = JSON.parse(f.readLocal("prepare-baseline.json").toString());
    expect(record.proofSource.continuation).toBeNull();
    expect(record.incomingHead).toBe(f.incoming);
    expect(f.readLocal("review.json")).toEqual(incoming);
    expect(existsSync(f.local("prepare-push-result.env"))).toBe(false);
    expect(existsSync(f.local("gates.env"))).toBe(false);
    f.prepGit("verify-commit", f.prepGit("rev-parse", "HEAD"));
  });

  it("keeps qualified succession available only after genuine new-candidate READY", () => {
    const f = fixture();
    const admitted = f.run(command, f.args, f.extra);
    expect(admitted.status, admitted.stdout + admitted.stderr).toBe(0);
    const head = f.prepGit("rev-parse", "HEAD");
    const review = {
      ...validReview(head),
      correction: {
        incomingHeadSha: f.published,
        incomingReviewJsonOid: f.oid("review.json"),
        resolvedFindings: [
          { id: "I1", resolution: "Independent exact-candidate proof was completed." },
        ],
      },
    };
    review.recommendation = "READY FOR /prepare-pr";
    review.issueValidation.status = "valid";
    f.writeLocal("correction-review.json", JSON.stringify(review));
    const advanced = f.run(
      "prepare-workflow-successor",
      flags({
        "--expected-binding": f.binding,
        "--from-workflow": JSON.parse(f.git(f.repo, "show", f.binding + ":binding.json"))
          .source as string,
        "--to-workflow": f.workflow,
        "--expected-head": head,
        "--expected-tree": f.tree,
        "--expected-review": f.oid("correction-review.json"),
        "--expected-hosted-head": f.published,
      }),
      f.extra,
    );
    expect(advanced.status, advanced.stdout + advanced.stderr).toBe(0);
    const gates = f.run("prepare-gates", [], { ...f.extra, OPENCLAW_PR_GATES_REMOTE: "github" });
    expect(gates.status, gates.stdout + gates.stderr).toBe(0);
    const publication = f.run("prepare-push", [], f.extra);
    expect(publication.status, publication.stdout + publication.stderr).toBe(0);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(head);
    const phases = f.local("review-phases");
    const hook = f.local("review-phase-hook.mjs");
    writeFileSync(
      hook,
      "import fs from 'node:fs';\nif (process.argv[1]?.endsWith('/correction-review.mjs')) { process.on('exit', status => { if (status === 0) fs.appendFileSync(" +
        JSON.stringify(phases) +
        ", JSON.stringify({ command: process.argv[2], main: process.env.OPENCLAW_PR_CAPTURED_MAIN ?? '' }) + '\\n'); }); }\n",
    );
    const merge = f.run("merge-run", ["--auto-merge"], {
      ...f.extra,
      NODE_OPTIONS: "--import=" + hook,
    });
    expect(merge.status).not.toBe(0); // External CI/policy observations are deliberately unavailable.
    const validations = readFileSync(phases, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { command: string; main: string });
    expect(validations).toContainEqual({ command: "validate-preflight", main: "" });
    expect(
      validations.some((item) => item.command === "validate" && item.main === f.baseline),
    ).toBe(true);
    expect(merge.stdout + merge.stderr).not.toContain(
      "Missing private canonical proof-baseline checkpoint",
    );
    f.writeLocal(
      "gates.env",
      "PR_NUMBER=42\nGATES_MODE=remote_crabbox_aws_pending\nLAST_VERIFIED_HEAD_SHA=" +
        head +
        "\nFULL_GATES_HEAD_SHA=''\nPENDING_CRABBOX_STATE=selected\nPENDING_CRABBOX_PR=42\nPENDING_CRABBOX_BASE_SHA=" +
        f.incoming +
        "\nPENDING_CRABBOX_HEAD_SHA=" +
        head +
        "\nPENDING_CRABBOX_ACTIONS_RUN_ID=99\nPENDING_CRABBOX_ATTEMPT=1\nPENDING_CRABBOX_WORKFLOW_SHA=" +
        f.baseline +
        "\n",
    );
    writeFileSync(phases, "");
    const resumed = f.run("prepare-push", ["--resume-crabbox-run", "99"], {
      ...f.extra,
      NODE_OPTIONS: "--import=" + hook,
    });
    // External CI observation is unavailable, but real source review must finish.
    expect(resumed.status).not.toBe(0);
    const resumedReviews = readFileSync(phases, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { command: string; main: string });
    expect(resumedReviews, resumed.stdout + resumed.stderr).toContainEqual({
      command: "validate",
      main: f.baseline,
    });
    expect(resumed.stdout + resumed.stderr).not.toContain(
      "Missing private canonical proof-baseline checkpoint",
    );
    expect(f.readLocal("gates.env").toString()).toContain("PENDING_CRABBOX_BASE_SHA=" + f.incoming);
    const baseline = f.advanceMain("qualified successor baseline");
    const successor = f.run("prepare-baseline-successor", f.successor(baseline), f.extra);
    expect(successor.status, successor.stdout + successor.stderr).toBe(0);
    const record = JSON.parse(f.readLocal("prepare-baseline.json").toString());
    expect(record.version).toBe(1);
    expect(record.sourceAdmission.predecessorHead).toBe(head);
    expect(existsSync(f.local("correction-review.json"))).toBe(false);
    expect(readFileSync(f.effects, "utf8")).toBe("push\n");
  });

  it.each([
    "missing-proof",
    "wrong-version",
    "wrong-purpose",
    "wrong-workflow",
    "wrong-binding",
    "wrong-tree",
    "wrong-review",
    "wrong-proof-lease",
    "stale-lease",
    "private-baseline",
    "unsigned-task",
    "unsigned-side",
  ])("refuses %s before a remote mutation or authority installation", (fault) => {
    const f = fixture();
    let args = [...f.args];
    const replace = (option: string, value: string) => {
      args = args.map((item, i) => (args[i - 1] === option ? value : item));
    };
    const review = structuredClone(f.review);
    if (fault === "wrong-review") {
      f.writeLocal("source-review.json", JSON.stringify(review) + "\n");
    } else if (fault === "missing-proof") {
      Reflect.deleteProperty(review.correction, "proofPublication");
    } else if (fault === "wrong-version") {
      review.correction.proofPublication.version = 2;
    } else if (fault === "wrong-purpose") {
      review.correction.proofPublication.kind = "approved";
    } else if (fault === "wrong-workflow") {
      review.correction.proofPublication.workflowSource = f.source;
    } else if (fault === "wrong-binding") {
      review.correction.proofPublication.workflowBinding = f.source;
    } else if (fault === "wrong-proof-lease") {
      review.correction.proofPublication.expectedHostedHead = f.incoming;
    } else if (fault === "wrong-tree") {
      review.correction.proofPublication.treeOid = "a".repeat(40);
    } else if (fault === "stale-lease") {
      mkdirSync(join(f.repo, ".local"), { recursive: true });
      writeFileSync(
        join(f.repo, ".local/live.json"),
        JSON.stringify({
          head: { ref: "topic", sha: f.incoming, repo: { full_name: "fixture/repo" } },
        }),
      );
    } else if (fault === "private-baseline") {
      const side = f.prepGit(
        "commit-tree",
        "--no-gpg-sign",
        f.tree,
        "-p",
        f.baseline,
        "-m",
        "test: private history",
      );
      replace("--baseline", side);
    } else {
      const unsigned = f.prepGit(
        "commit-tree",
        "--no-gpg-sign",
        f.tree,
        "-p",
        fault === "unsigned-side" ? f.baseline : f.source,
        "-m",
        "test: unsigned task",
      );
      const head =
        fault === "unsigned-side"
          ? f.prepGit(
              "commit-tree",
              "-S",
              f.tree,
              "-p",
              f.source,
              "-p",
              unsigned,
              "-m",
              "test: side parent",
            )
          : unsigned;
      f.prepGit("update-ref", "refs/heads/pr-42-prep", head, f.source);
      replace("--expected-head", head);
      Object.assign(review, f.proofReview(head, f.published, f.oid("review.json")));
    }
    if (fault !== "wrong-review") {
      f.writeLocal("source-review.json", JSON.stringify(review));
      replace("--expected-review", f.oid("source-review.json"));
    }
    const result = f.run(command, args, f.extra);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    const error = result.stdout + result.stderr;
    const expected =
      fault === "wrong-review"
        ? /Selected proof source review changed/u
        : fault === "wrong-proof-lease"
          ? /Proof source hosted lease changed/u
          : fault === "private-baseline"
            ? /merge-base --is-ancestor/u
            : fault.startsWith("unsigned")
              ? /verify-commit/u
              : fault === "stale-lease"
                ? /PR head changed|PR identity changed/u
                : /Proof publication requires|workflow continuation changed|does not exist/u;
    expect(error).toMatch(expected);
    f.expectSnapshot(f.before);
    expect(existsSync(f.local("prepare-baseline.json"))).toBe(false);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(existsSync(f.effects)).toBe(false);
    expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.published);
  });

  it("refuses unknown, duplicate and unsupported proof combinations before lock or network", () => {
    const f = fixture();
    for (const [selected, args] of [
      [command, [...f.args, "--for-proof"]],
      [command, [...f.args, "--unknown", "value"]],
      [command, [...f.args, "--expected-tree", f.tree]],
      [command, [...f.args, "--coauthors", "a.json", "--coauthors", "b.json"]],
      [command, ["--expected-head", f.source, "--baseline", f.baseline, "--coauthors", "a.json"]],
      ["prepare-baseline-successor", f.args],
      ["prepare-baseline-signing-request", f.args],
      ["prepare-baseline-signing-continue", ["--for-proof"]],
    ] as const) {
      const result = f.run(selected, [...args], f.extra);
      expect(result.status, result.stdout + result.stderr).toBe(2);
      expect(
        f.git(
          f.repo,
          "for-each-ref",
          "--format=%(objectname)",
          "refs/openclaw/pr-operation-locks/",
        ),
      ).toBe("");
      expect(existsSync(f.effects)).toBe(false);
      f.expectSnapshot(f.before);
    }
  });

  it("rejects malformed co-author metadata before changing preparation or publication", () => {
    const f = fixture();
    const before = nativeState(f);
    for (const value of [
      {},
      [null],
      ["No email"],
      ["Name <a@example.invalid>\nBaseline-Refresh: " + "a".repeat(40)],
      ["Name\u2028Injected <a@example.invalid>"],
      ["Name <a@example.invalid>\rCo-authored-by: Other <b@example.invalid>"],
      ["Name <a\u0001@example.invalid>"],
      ["Name <a\u007f@example.invalid>"],
    ]) {
      f.writeLocal("coauthors.json", JSON.stringify(value));
      const entries = readdirSync(f.local(".")).toSorted();
      const result = f.run(command, [...f.args, "--coauthors", f.local("coauthors.json")], f.extra);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/co-author|co-authors/u);
      expect(nativeState(f)).toEqual(before);
      expect(readdirSync(f.local(".")).toSorted()).toEqual(entries);
      f.expectSnapshot(f.before);
    }
  });

  it("refuses replaced operation custody after a hosted observation", () => {
    const f = fixture();
    const marker = f.local("owner-replaced");
    replaceCustodyAfterObservation(f, marker);
    const beforeCustodyLoss = nativeState(f);
    const result = f.run(command, f.args, f.extra);
    nativeTrace(f, "refused-replaced-custody-admission", beforeCustodyLoss, result, 0);
    expect(nativeState(f)).toEqual(beforeCustodyLoss);
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8")).objectType).toBe("blob");
    expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toBe(f.source);
    expect(existsSync(f.local("prepare-baseline.json"))).toBe(false);
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(existsSync(f.effects)).toBe(false);
    f.expectSnapshot(f.before);
  });

  it("recovers only the original signed transition after an interrupted restore", () => {
    const f = fixture();
    // Force a non-identical materialization so the real restore owner is reached.
    writeFileSync(join(f.repo, "docs/upstream.md"), "canonical upstream\n");
    f.git(f.repo, "add", "docs/upstream.md");
    f.git(f.repo, "commit", "-qm", "test: newer canonical main");
    const baseline = f.git(f.repo, "rev-parse", "HEAD");
    const sourceReview = structuredClone(f.review);
    sourceReview.correction.proofPublication.workflowSource = baseline;
    f.writeLocal("source-review.json", JSON.stringify(sourceReview));
    f.git(f.repo, "fetch", "-q", "origin", "main");
    const selected = f.args.map((value, index) =>
      f.args[index - 1] === "--baseline"
        ? baseline
        : f.args[index - 1] === "--expected-review"
          ? f.oid("source-review.json")
          : value,
    );
    const coauthors = ["Renée Example <renee@example.invalid>"];
    f.writeLocal("coauthors.json", JSON.stringify(coauthors));
    const args = [...selected, "--coauthors", f.local("coauthors.json")];
    const failed = f.run(command, args, { ...f.extra, ...failRestore(f.root, f.env) });
    expect(failed.status).not.toBe(0);
    const journal = f.readLocal("review-transition.json");
    const target = JSON.parse(journal.toString()).target as string;
    const record = JSON.parse(
      Buffer.from(JSON.parse(journal.toString()).binding as string, "base64").toString(),
    );
    expect(record.coauthors).toEqual(coauthors);
    const beforeChangedCredit = nativeState(f);
    f.writeLocal("coauthors.json", JSON.stringify(["Other Example <other@example.invalid>"]));
    const changedCredit = f.run(command, args, f.extra);
    expect(changedCredit.status).not.toBe(0);
    expect(changedCredit.stderr).toContain("co-author attribution changed");
    expect(nativeState(f)).toEqual(beforeChangedCredit);
    expect(f.readLocal("review-transition.json")).toEqual(journal);
    f.writeLocal("coauthors.json", JSON.stringify(coauthors));
    const evidence = join(f.worktree, record.archive as string, "baseline-source-review.json");
    const bytes = readFileSync(evidence);
    writeFileSync(evidence, Buffer.concat([bytes, Buffer.from("\n")]));
    const changed = f.run(command, args, f.extra);
    expect(changed.status).not.toBe(0);
    expect(changed.stdout + changed.stderr).toContain("Proof baseline source identity changed");
    expect(f.readLocal("review-transition.json")).toEqual(journal);
    writeFileSync(evidence, bytes);
    const refused = f.run(command, f.args, f.extra);
    expect(refused.status).not.toBe(0);
    expect(f.readLocal("review-transition.json")).toEqual(journal);
    const replacement = f.local("recovery-owner-replaced");
    replaceCustodyAfterObservation(f, replacement);
    const beforeRecoveryLoss = nativeState(f);
    const lost = f.run(command, args, f.extra);
    nativeTrace(f, "refused-replaced-custody-recovery", beforeRecoveryLoss, lost, 0);
    expect(lost.status, lost.stdout + lost.stderr).not.toBe(0);
    expect(JSON.parse(readFileSync(replacement, "utf8")).objectType).toBe("blob");
    expect(f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toBe(f.source);
    expect(nativeState(f)).toEqual(beforeRecoveryLoss);
    expect(f.readLocal("review-transition.json")).toEqual(journal);
    // The injected foreign ref belongs only to this settled private fixture.
    f.git(f.repo, "update-ref", "-d", "refs/openclaw/pr-operation-locks/42", f.source);
    const beforeRecovery = nativeState(f);
    const recovered = f.run(command, args, f.extra);
    nativeTrace(f, "allowed-original-transition-recovery", beforeRecovery, recovered, 0);
    expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(target);
    expect(f.prepGit("show", "-s", "--format=%B", target)).toContain(
      "Co-authored-by: Ada Example <ada@example.invalid>\nCo-authored-by: Renée Example <renee@example.invalid>",
    );
    expect(existsSync(f.local("review-transition.json"))).toBe(false);
    expect(existsSync(f.effects)).toBe(false);
    expect(f.run(command, args, f.extra).status).toBe(0);
    f.writeLocal("coauthors.json", JSON.stringify(["Other Example <other@example.invalid>"]));
    const changedCompleted = f.run(command, args, f.extra);
    expect(changedCompleted.status).not.toBe(0);
    expect(changedCompleted.stderr).toContain("Completed baseline differs");
    expect(f.prepGit("rev-parse", "HEAD")).toBe(target);
    expect(existsSync(f.effects)).toBe(false);
  });
});
