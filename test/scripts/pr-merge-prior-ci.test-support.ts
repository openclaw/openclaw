import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

type MergeFixture = ReturnType<ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"]>;

export function createPriorCiFixtureState(head: string) {
  return {
    enabled: false,
    head,
    runHead: head,
    runConclusion: "success",
    latestAttempt: 2,
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
          steps?: Array<{ number: number; name: string; status: string; conclusion: string }>;
        }>
      | undefined,
    event: "workflow_dispatch",
    branch: "topic",
    workflowPath: ".github/workflows/ci.yml",
    missingCheck: "",
    reviewDecision: "APPROVED" as string | null | undefined,
    reviewCount: 1,
    requireCodeOwners: false,
    requireLastPush: false,
    requireThreads: false,
    resolved: true,
    membership: "admin",
    revokeAdminOnMainFetch: false,
    unsupportedNoLazy: false,
    adminRevokedDuringMainFetch: false,
    evidencePath: "",
    mutateEvidence: false,
    otherCheck: "",
    security: {
      enabled: false,
      fault: "",
      sourceSha: "",
      combinedState: "failure",
      approval: false,
      role: "admin",
      statusReads: 0,
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
    event:"workflow_run",path:config.fault==="foreign-workflow"?".github/workflows/unrelated.yml":".github/workflows/security-review.yml"};
  const reply=(value)=>out(args.includes("--include")?"HTTP/2.0 200 OK\n\n"+JSON.stringify(value):args.includes("--slurp")?[value]:value);
  if(endpoint.includes("/statuses?")) {
    config.statusReads++;save();
    const statuses=securityStatuses();
    const earlier={...statuses.find(status=>status.context==="openclaw/security-sensitive-review"),id:701,context:"openclaw/security-sensitive-review",state:"failure",created_at:"2026-09-19T00:00:00Z",updated_at:"2026-09-19T00:00:00Z"};
    reply(config.fault==="missing-guard"?statuses:[...statuses,earlier]);
  } else if(endpoint.includes("/status?")) {
    const statuses=securityStatuses().map(({creator,...status})=>status);
    const state=statuses.some(status=>["failure","error"].includes(status.state))?"failure":statuses.some(status=>status.state==="pending")?"pending":"success";
    reply({total_count:statuses.length,sha:s.pr.headRefOid,state,statuses});
  } else if(endpoint.startsWith("repos/fixture/repo/actions/runs/901")&&endpoint.includes("/jobs?")) {
    const jobs=[{id:902,run_id:901,head_sha:source,name:"review (123, "+s.pr.headRefOid+")",status:"completed",conclusion:"success",
      steps:config.fault==="missing-enforcement"?[]:[{name:"Enforce security review",status:"completed",conclusion:"success",started_at:"2026-09-20T00:00:00Z",completed_at:"2026-09-20T00:01:00Z"}]}];
    reply({total_count:config.fault==="incomplete-publisher"?2:1,jobs});
  } else if(endpoint.startsWith("repos/fixture/repo/actions/runs/901")) {
    reply(endpoint.includes("/attempts/")?{...publisher,run_attempt:1}:publisher);
  } else if(endpoint.startsWith("repos/fixture/repo/contents/")) {
    const path=endpoint.slice("repos/fixture/repo/contents/".length).split("?")[0];
    const bytes=fs.readFileSync(process.env.FIXTURE_SCRIPTS+"/../"+path);
    const sha=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
    reply({type:"file",path,sha:config.fault==="changed-publisher-source"?"0".repeat(40):sha});
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
  const blob = f.git(["hash-object", "-w", "--stdin"], workflow);
  const workflows = f.git(["mktree"], `100644 blob ${blob}\tci.yml\n`);
  const github = f.git(["mktree"], `040000 tree ${workflows}\tworkflows\n`);
  const entries = f
    .git(["ls-tree", treeish])
    .split("\n")
    .filter((entry) => !entry.endsWith("\t.github"));
  return f.git(["mktree"], [...entries, `040000 tree ${github}\t.github`, ""].join("\n"));
}

export function createPriorCiCandidateFactory(
  fixture: ReturnType<typeof createMergeOutcomeFixtureHarness>["fixture"],
) {
  function candidate() {
    const f = fixture(undefined, [["first change\n"], ["resolved conflict\n"]]);
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
    writeFileSync(
      join(f.worktree, ".local/gates.env"),
      `GATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
    );
    const delta = f.git([
      "diff",
      "--raw",
      "--abbrev=40",
      "--no-renames",
      "-z",
      state.priorCi.head,
      f.head,
      "--",
    ]);
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
      deltaSha256: createHash("sha256").update(delta).digest("hex"),
      reason: "Explicit operator approval after resolving the source conflict",
      contracts: ["owner output"],
      checks: [
        { command: "owner test", result: "passed", evidence: "Observed resolved owner output" },
      ],
    };
    writeFileSync(path, JSON.stringify(evidence));
    return { ...f, path, evidence };
  }

  function preExistingCandidate(workflow?: string) {
    const f = candidate();
    let main = f.base;
    if (workflow) {
      main = f.commit(ciWorkflowTree(f, f.base, workflow), [f.base]);
      f.git(["push", "-q", "origin", `${main}:refs/heads/main`]);
      f.prepare(f.head, main);
      writeFileSync(
        join(f.worktree, ".local/gates.env"),
        `GATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
      );
    }
    const state = f.state();
    state.gates = "fail";
    state.pr.mergeStateStatus = "BLOCKED";
    state.priorCi.runHead = f.head;
    state.priorCi.event = "pull_request";
    state.priorCi.runConclusion = "cancelled";
    state.priorCi.security.enabled = true;
    state.priorCi.security.sourceSha = main;
    const job = (id: number, name: string, conclusion: string) => ({
      id,
      name,
      conclusion,
      status: "completed",
      run_id: 501,
      head_sha: f.head,
      steps: [],
    });
    state.priorCi.jobs = [
      job(601, "owner-tests", "failure"),
      {
        ...job(602, "openclaw/ci-gate", "failure"),
        check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/1",
      },
      {
        ...job(603, "pr-fail-fast", "success"),
        steps: [
          {
            number: 2,
            name: "Cancel remaining PR work after a failure",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      job(604, "cancelled-sibling", "cancelled"),
      job(605, "security-fast", "success"),
    ];
    f.save(state);
    const artifact = join(f.root, "qualification.txt");
    writeFileSync(
      artifact,
      "Inspected checkout, unchanged sibling input, independent baseline failure, and fail-fast cancellation.\n",
    );
    const evidence = {
      ...f.evidence,
      changeKind: "pre-existing-failure",
      priorHead: main,
      testedMerge: f.commit(f.git(["merge-tree", "--write-tree", main, f.head]), [main, f.head]),
      deltaSha256: createHash("sha256")
        .update(f.git(["diff", "--raw", "--abbrev=40", "--no-renames", "-z", main, f.head, "--"]))
        .digest("hex"),
      artifacts: [
        {
          name: "qualification",
          path: artifact,
          sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
        },
      ],
      checkout: { reason: "Inspected the exact preflight checkout", evidence: ["qualification"] },
      failures: [
        {
          jobId: 601,
          reason: "The same independent failure predates the PR",
          cases: ["sibling assertion"],
          sourcePaths: ["sibling.txt"],
          evidence: ["qualification"],
        },
      ],
      aggregate: {
        jobId: 602,
        causedBy: [601],
        reason: "Aggregate reports the admitted root failure",
        evidence: ["qualification"],
      },
      cancellation: {
        jobId: 603,
        step: 2,
        jobIds: [604],
        causedBy: [601],
        reason: "Inspected fail-fast step cancelled the sibling",
        evidence: ["qualification"],
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
      reason: "Independently qualified baseline failure; cancelled siblings remain unrun",
    };
    writeFileSync(reviewPath, JSON.stringify(review));
    return { ...f, base: main, evidence, artifact };
  }

  return { candidate, preExistingCandidate };
}
