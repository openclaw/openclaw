import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

type MergeFixture = ReturnType<ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"]>;
const digest = (contents: string | Buffer) => createHash("sha256").update(contents).digest("hex");
const rawDelta = (f: MergeFixture, from: string) =>
  f.git(["diff", "--raw", "--abbrev=40", "--no-renames", "-z", from, f.head, "--"]);
function writePendingGates(f: MergeFixture) {
  writeFileSync(
    join(f.worktree, ".local/gates.env"),
    `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
  );
}
const qualification = (reason: string) => ({ reason, evidence: ["qualification"] });

export function createPriorCiFixtureState(head: string) {
  const annotation = (start_line: number, message: string) => ({
    annotation_level: "failure",
    title: "",
    message,
    path: ".github",
    start_line,
  });
  return {
    enabled: false,
    head,
    runHead: head,
    runConclusion: "success",
    latestAttempt: 2,
    jobPageFault: "",
    omitPullRequests: false,
    sourceRepository: { id: 1103012935, full_name: "fixture/repo" },
    runRepository: undefined as { id: number; full_name: string } | undefined,
    jobs: undefined as
      | Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string;
          run_id: number;
          head_sha: string;
          check_run_url?: string;
          started_at?: string;
          completed_at?: string;
          steps?: Array<{
            number: number;
            name: string;
            status: string;
            conclusion: string;
            started_at?: string;
            completed_at?: string;
          }>;
        }>
      | undefined,
    event: "workflow_dispatch",
    branch: "topic",
    workflowPath: ".github/workflows/ci.yml",
    artifactBuild: false,
    artifactFault: "",
    missingCheck: "",
    currentGateChecks: [] as Array<{
      id: number;
      suiteId?: number;
      event: string;
      conclusion: string | null;
      status?: string;
      publisherId?: number;
      name?: string;
      startedAt?: string;
    }>,
    reviewDecision: "APPROVED" as string | null | undefined,
    reviewCount: 1,
    requireCodeOwners: false,
    requireLastPush: false,
    requireThreads: false,
    resolved: true,
    membership: "admin",
    membershipReads: 0,
    revokeMembershipAfterReads: 0,
    rulesetBypass: undefined as string | undefined,
    rulesetReads: 0,
    revokeRulesetAfterRead: false,
    revokeRulesetAfterReads: 1,
    revokeAdminOnMainFetch: false,
    unsupportedNoLazy: false,
    localOnlyFailureOid: "",
    localOnlyFailureStderr: "",
    localOnlyQueryFault: "",
    adminRevokedDuringMainFetch: false,
    evidencePath: "",
    mutateEvidence: false,
    otherCheck: "",
    nativeChecks: [] as Array<{
      name: string;
      kind: "check" | "status";
      required: boolean;
      state: "success" | "failure" | "pending";
      previousFailure?: boolean;
    }>,
    nativeOptionalCount: 0,
    nativeMissingResult: false,
    nativeResultApp: 15368,
    nativePageFault: "",
    security: {
      enabled: false,
      fault: "",
      publisherEvent: "workflow_run",
      sourceSha: "",
      combinedState: "failure",
      approval: false,
      role: "admin",
      statusReads: 0,
    },
    deadline: {
      check: {
        id: 601,
        name: "owner-tests",
        head_sha: head,
        status: "completed",
        conclusion: "cancelled",
        started_at: "2026-09-20T00:00:00Z",
        completed_at: "2026-09-20T01:00:20Z",
        app: { id: 15368, slug: "github-actions" },
        check_suite: { id: 10 },
        output: { annotations_count: 2 },
      },
      annotations: [
        annotation(1, "The job has exceeded the maximum execution time of 1h0m0s"),
        annotation(18, "The operation was canceled."),
      ],
    },
  };
}

export const priorCiSecurityFixtureSource = String.raw`
const securityStatuses=()=>{
  const config=s.priorCi.security;
  const common={creator:{id:41898282,login:"github-actions[bot]",type:"Bot"},
    target_url:s.repo.url+"/actions/runs/901",created_at:"2026-09-20T00:00:20Z",updated_at:"2026-09-20T00:00:20Z"};
  const combined={...common,id:801,context:"openclaw/ci-gate",state:config.combinedState,
    description:"PR #123: "+(config.combinedState==="success"?"CI and applicable security review requirements passed":config.combinedState==="pending"?"Waiting for CI; review updates automatically":"CI must complete successfully; review updates automatically"),
    created_at:"2026-09-20T00:00:30Z",updated_at:"2026-09-20T00:00:30Z"};
  const statuses=[combined,
    {...common,id:802,context:"openclaw/dependency-review",state:"success",description:"PR #123: No dependency changes require review."},
    {...common,id:803,context:"openclaw/security-sensitive-review",state:config.fault==="failed-guard"?"failure":"success",description:"PR #123: "+(config.approval?"Sensitive changes have maintainer authority":"No sensitive product changes")}];
  if(config.fault==="missing-guard") statuses.pop();
  if(config.fault==="missing-status") statuses.shift();
  if(config.fault==="foreign-publisher") combined.creator={id:999,login:"another-bot",type:"Bot"};
  if(config.fault==="stale-status") combined.created_at=combined.updated_at="2026-09-19T00:00:30Z";
  if(config.fault==="status-drift"&&config.statusReads>1) combined.id=804;
  return statuses;
};
const securityResponse=()=>{
  if(!s.priorCi.security.enabled||args[0]!=="api") return false;
  const endpoint=args.find(arg=>arg.startsWith("repos/fixture/repo/"));
  if(!endpoint) return false;
  const config=s.priorCi.security;
  const source=config.sourceSha||main();
  const publisher={id:901,run_attempt:config.fault==="new-publisher-attempt"?2:1,status:"completed",conclusion:"success",
    head_sha:source,head_branch:"main",head_repository:{id:s.repoAuthority.id},repository:{id:s.repoAuthority.id,full_name:s.repo.nameWithOwner},
    event:config.fault==="unsupported-event"?"repository_dispatch":config.publisherEvent,
    actor:{id:41898282,login:"github-actions[bot]",type:"Bot"},
    path:config.fault==="foreign-workflow"?".github/workflows/unrelated.yml":".github/workflows/security-review.yml"};
  const reply=(value)=>out(args.includes("--include")?"HTTP/2.0 200 OK\n\n"+JSON.stringify(value):args.includes("--slurp")?[value]:value);
  if(endpoint.includes("/statuses?")) {
    config.statusReads++;save();
    const statuses=securityStatuses();
    const earlier={...statuses.find(status=>status.context==="openclaw/security-sensitive-review"),id:701,context:"openclaw/security-sensitive-review",state:"failure",created_at:"2026-09-19T00:00:00Z",updated_at:"2026-09-19T00:00:00Z"};
    reply(config.fault==="missing-guard"?statuses:[...statuses,earlier]);
  } else if(endpoint.includes("/status?")) {
    const statuses=[...securityStatuses().map(({creator,...status})=>status),...nativeChecks().filter(check=>check.kind==="status").map((check,index)=>({id:900+index,context:check.name,state:check.state}))];
    const state=statuses.some(status=>["failure","error"].includes(status.state))?"failure":statuses.some(status=>status.state==="pending")?"pending":"success";
    reply({total_count:statuses.length,sha:s.pr.headRefOid,state,statuses});
  } else if(endpoint.startsWith("repos/fixture/repo/actions/runs/901")&&endpoint.includes("/jobs?")) {
    const headName="review (123, "+s.pr.headRefOid+")";
    const attemptName="review (123, "+s.pr.headRefOid+", "+(config.fault==="wrong-ci-run"?503:s.priorCi.artifactBuild?502:501)+", "+(config.fault==="wrong-ci-attempt"?3:2)+")";
    const jobs=[{id:902,run_id:901,head_sha:source,name:config.fault==="head-only-enforcement"?headName:attemptName,status:"completed",conclusion:"success",
      steps:config.fault==="missing-enforcement"?[]:[{name:"Enforce security review",status:"completed",conclusion:"success",started_at:"2026-09-20T00:00:00Z",completed_at:"2026-09-20T00:01:00Z"}]}];
    if(config.fault==="duplicate-enforcement") jobs.push({...jobs[0],id:903,name:headName});
    reply({total_count:jobs.length+(config.fault==="incomplete-publisher"?1:0),jobs});
  } else if(endpoint.startsWith("repos/fixture/repo/actions/runs/901")) {
    reply(endpoint.includes("/attempts/")?{...publisher,run_attempt:1}:publisher);
  } else if(endpoint.startsWith("repos/fixture/repo/contents/")) {
    const path=endpoint.slice("repos/fixture/repo/contents/".length).split("?")[0];
    const revision=new URLSearchParams(endpoint.split("?")[1]).get("ref");
    const bytes=execFileSync("git",["--git-dir="+process.env.FIXTURE_REMOTE,"show",revision+":"+path],{env:process.env});
    const sha=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
    reply({type:"file",path,sha:config.fault==="changed-publisher-source"&&path!==publisher.path?"0".repeat(40):sha,
      encoding:config.fault==="malformed-workflow"?"utf8":"base64",
      content:config.fault==="changed-workflow-bytes"?Buffer.from("different bytes").toString("base64"):bytes.toString("base64")});
  } else if(endpoint.startsWith("repos/fixture/repo/compare/")) {
    reply({base_commit:{sha:source},merge_base_commit:{sha:config.fault==="untrusted-publisher-source"?"0".repeat(40):source},status:endpoint.includes("..."+source+"?")?"identical":"ahead"});
  } else if(endpoint==="repos/fixture/repo/pulls/152415") {
    reply({number:152415,base:{ref:"main",repo:{full_name:s.repo.nameWithOwner}},state:"closed",merged:true,merged_at:"2026-09-01T00:00:00Z",merge_commit_sha:source});
  } else if(endpoint.includes("/collaborators/")) {
    reply({role_name:config.role});
  } else if(endpoint.startsWith("repos/fixture/repo/issues/123/comments?")&&args.includes("--include")) {
    reply([]);
  } else return false;
  return true;
};
`;

export function ciWorkflowTree(f: MergeFixture, treeish: string, workflow: string) {
  let oid = f.git(["hash-object", "-w", "--stdin"], workflow);
  for (const [directory, name, kind] of [
    [":.github/workflows", "ci.yml", "100644 blob"],
    [":.github", "workflows", "040000 tree"],
    ["", ".github", "040000 tree"],
  ]) {
    const entries = f
      .git(["ls-tree", `${treeish}${directory}`])
      .split("\n")
      .filter((entry) => !entry.endsWith(`\t${name}`));
    oid = f.git(["mktree"], [...entries, `${kind} ${oid}\t${name}`, ""].join("\n"));
  }
  return oid;
}

export function createPriorCiCandidateFactory(
  fixture: ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"],
) {
  function candidate(existing?: ReturnType<typeof fixture>) {
    const f = existing ?? fixture(undefined, [["first change\n"], ["resolved conflict\n"]]);
    const state = f.state();
    const path = join(f.root, "admin.json");
    state.priorCi.enabled = true;
    state.priorCi.evidencePath = path;
    state.repoAuthority.owner = { login: "fixture", type: "Organization" };
    state.restPolicy = "rules";
    state.requiredCheckName = "openclaw/ci-gate";
    state.restContexts = ["openclaw/ci-gate", "Security Review"];
    state.gates = "pending";
    state.pr.mergeStateStatus = "BEHIND";
    f.save(state);
    writePendingGates(f);
    // The fixture git helper trims output; this raw form terminates with NUL, so
    // no bytes belonging to the delta are removed.
    const evidence = {
      version: 1,
      changeKind: "conflict-resolution",
      repository: "fixture/repo",
      pr: 123,
      head: f.head,
      priorHead: state.priorCi.head,
      runId: 501,
      runAttempt: 2,
      deltaSha256: digest(rawDelta(f, state.priorCi.head)),
      reason: "Operator approved the resolved conflict",
      contracts: ["owner output"],
      checks: [{ command: "owner test", result: "passed", evidence: "Resolved owner output" }],
    };
    writeFileSync(path, JSON.stringify(evidence));
    return { ...f, path, evidence };
  }

  function preExistingCandidate(workflow?: string, existing?: ReturnType<typeof fixture>) {
    const f = candidate(existing);
    let main = f.base;
    if (workflow) {
      main = f.commit(ciWorkflowTree(f, f.base, workflow), [f.base]);
      f.git(["push", "-q", "origin", `${main}:refs/heads/main`]);
      f.prepare(f.head, main);
      writePendingGates(f);
    }
    const state = f.state();
    state.gates = "fail";
    state.pr.mergeStateStatus = "BLOCKED";
    state.priorCi.runHead = f.head;
    state.priorCi.event = "pull_request";
    state.priorCi.runConclusion = "cancelled";
    state.priorCi.security.enabled = true;
    state.priorCi.security.sourceSha = main;
    state.priorCi.jobs = (
      [
        ["owner-tests", "failure"],
        ["openclaw/ci-gate", "failure"],
        ["pr-fail-fast", "success"],
        ["cancelled-sibling", "cancelled"],
        ["security-fast", "success"],
      ] as const
    ).map(([name, conclusion], index) => ({
      id: 601 + index,
      name,
      conclusion,
      status: "completed",
      run_id: 501,
      head_sha: f.head,
      steps: [],
    }));
    state.priorCi.jobs[1]!.check_run_url = "https://api.github.com/repos/fixture/repo/check-runs/1";
    // Retained receipts still use the retired workflow's cancellation step.
    state.priorCi.jobs[2]!.steps = [
      {
        number: 2,
        name: "Cancel remaining PR work after a failure",
        status: "completed",
        conclusion: "success",
      },
    ];
    f.save(state);
    const artifact = join(f.root, "qualification.txt");
    writeFileSync(artifact, "Inspected unchanged input, baseline failure, and cancellation.\n");
    const evidence = {
      ...f.evidence,
      changeKind: "pre-existing-failure",
      priorHead: main,
      testedMerge: f.commit(f.git(["merge-tree", "--write-tree", main, f.head]), [main, f.head]),
      deltaSha256: digest(rawDelta(f, main)),
      artifacts: [
        { name: "qualification", path: artifact, sha256: digest(readFileSync(artifact)) },
      ],
      checkout: qualification("Inspected exact preflight checkout"),
      failures: [
        {
          jobId: 601,
          ...qualification("Independent failure predates PR"),
          cases: ["sibling assertion"],
          sourcePaths: ["sibling.txt"],
        },
      ],
      aggregate: {
        jobId: 602,
        causedBy: [601],
        ...qualification("Aggregate reports admitted root"),
      },
      cancellation: {
        jobId: 603,
        step: 2,
        jobIds: [604],
        causedBy: [601],
        ...qualification("Fail-fast step cancelled sibling"),
      },
    };
    writeFileSync(f.path, JSON.stringify(evidence));
    const reviewPath = join(f.worktree, ".local/review.json");
    const review = JSON.parse(readFileSync(reviewPath, "utf8"));
    review.tests.result = "fail";
    review.tests.preExistingCi = {
      head: f.head,
      runId: 501,
      runAttempt: 2,
      reason: "Qualified baseline failure; cancelled siblings remain unrun",
    };
    writeFileSync(reviewPath, JSON.stringify(review));
    return { ...f, base: main, evidence, artifact };
  }

  function artifactBuildCandidate() {
    const f = preExistingCandidate();
    const state = f.state();
    Object.assign(state.priorCi, {
      artifactBuild: true,
      runConclusion: "failure",
      workflowPath: ".github/workflows/ci-build-artifacts-testbox.yml",
    });
    state.gates = "pass";
    state.priorCi.security.combinedState = "success";
    state.priorCi.security.publisherEvent = "workflow_dispatch";
    state.priorCi.jobs = ["build-artifacts", "admission"].map((name, index) => ({
      id: 601 + index,
      name,
      status: "completed",
      conclusion: index === 0 ? "failure" : "skipped",
      run_id: 501,
      head_sha: f.head,
      check_run_url: `https://api.github.com/repos/fixture/repo/check-runs/${601 + index}`,
    }));
    f.save(state);
    const { aggregate: _aggregate, cancellation: _cancellation, ...attribution } = f.evidence;
    const evidence = {
      ...attribution,
      primaryCi: { runId: 502, runAttempt: 2 },
      failures: f.evidence.failures.map((failure) => ({
        ...failure,
        sourcePaths: [...failure.sourcePaths, ".github/workflows/ci-build-artifacts-testbox.yml"],
      })),
    };
    writeFileSync(f.path, JSON.stringify(evidence));
    return { ...f, evidence };
  }

  return { candidate, preExistingCandidate, artifactBuildCandidate };
}
