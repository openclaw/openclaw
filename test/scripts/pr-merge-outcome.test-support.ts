import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect } from "vitest";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createFixtureGit } from "./pr-merge-fixture-git.test-support.js";
import { landingSnapshotQuery } from "./pr-merge-snapshot.test-support.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

export function createMergeOutcomeFixtureHarness() {
  const temps = useAutoCleanupTempDirTracker(afterEach);
  const templateDirs = useAutoCleanupTempDirTracker(afterAll);
  let fixtureTemplate: ReturnType<typeof createFixtureTemplate> | undefined;
  const scripts = join(process.cwd(), "scripts");
  const nodeExecutable = requireNodeTool("node");
  const nodeArgs = resolveVitestNodeArgs();
  const outcomeRef = "refs/openclaw/pr-merge-outcomes/123";
  const lockRef = "refs/openclaw/pr-operation-locks/123";
  const describePosix = process.platform === "win32" ? describe.skip : describe;
  const unknownProjection = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Merge Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Merge Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  // Git 2.45 introduced no-lazy-fetch; older Git cannot prove offline probes.
  const supportsNoLazyFetch =
    spawnSync("git", ["--no-lazy-fetch", "--version"], { env: gitEnv }).status === 0;

  function createFixtureTemplate(directory: string) {
    const root = realpathSync(directory);
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    mkdirSync(repo);
    const { git, tree, commit } = createFixtureGit(repo, gitEnv);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Merge Fixture"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["init", "-q", "--bare", remote]);
    const base = commit(tree("before\n"), []);
    git(["update-ref", "refs/heads/main", base]);
    return { repo, remote, base, compileCache: join(root, "node-compile-cache") };
  }

  function fixture(
    sourceMessage?: string,
    sourceVersions: Array<[string, string?]> = [["after\n"]],
    promisor = false,
    sourceAuthor?: { name: string; email: string },
  ) {
    const root = realpathSync(temps.make("pr-merge-outcome-"));
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    const template = (fixtureTemplate ??= createFixtureTemplate(
      templateDirs.make("pr-merge-outcome-template-"),
    ));
    // Only the common base is reused. Source commits stay fresh, loose and private
    // so corruption, GC, attribution and multi-commit rebase cases keep their proof.
    const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
    cpSync(template.repo, repo, copyOptions);
    cpSync(template.remote, remote, copyOptions);
    const { base } = template;
    const { git, tree, commit } = createFixtureGit(repo, gitEnv);
    git(["remote", "add", "origin", remote]);
    const sourceCommits: string[] = [];
    let head = base;
    for (const [owner, sibling] of sourceVersions) {
      head = commit(tree(owner, sibling), [head], sourceMessage, sourceAuthor);
      sourceCommits.push(head);
    }
    git(["update-ref", "refs/heads/topic", head]);
    git(["push", "-q", "origin", "main", "topic:refs/pull/123/head", "topic"]);
    if (promisor) {
      git(["--git-dir=" + remote, "config", "uploadpack.allowFilter", "true"]);
      renameSync(repo, join(root, "seed"));
      git(
        [
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "--branch=topic",
          `file://${remote}`,
          repo,
        ],
        undefined,
        root,
      );
      expect(git(["config", "--bool", "remote.origin.promisor"])).toBe("true");
      expect(
        readdirSync(join(repo, ".git/objects/pack")).some((name) => name.endsWith(".promisor")),
      ).toBe(true);
    }
    // Production URLs still use the real Git transport, redirected only in this disposable repo.
    git(["config", `url.file://${remote}.insteadOf`, "https://github.com/fixture/repo"]);
    git([
      "config",
      "--add",
      `url.file://${remote}.insteadOf`,
      "https://github.com/fixture/repo.git",
    ]);
    const worktree = join(repo, ".worktrees/pr-123");
    git(["worktree", "add", "-q", "-b", "pr-123-prep", worktree, head]);
    // Match the real repository: native review artifacts are ignored generated files.
    writeFileSync(join(repo, ".git/info/exclude"), ".local/\n");
    mkdirSync(join(worktree, ".local"));
    const prepare = (preparedHead: string, main = base, localHead = preparedHead) => {
      const review = validReview(preparedHead);
      review.pr.number = 123;
      review.recommendation = "READY FOR /prepare-pr";
      review.issueValidation.status = "valid";
      writeReviewArtifacts(worktree, review, { headSha: preparedHead, prNumber: 123 });
      writeFileSync(
        join(worktree, ".local/prep.env"),
        `PR_NUMBER=123\nPREP_HEAD_SHA=${preparedHead}\nLOCAL_PREP_HEAD_SHA=${localHead}\nPREP_MAINLINE_BASE_SHA=${main}\nPREP_REPLACED_HOSTED_ANCESTRY=false\nPREP_AUTHOR_ACCESS=external\n`,
      );
      writeFileSync(
        join(worktree, ".local/prep-context.env"),
        `PR_NUMBER=123\nPR_HEAD_SHA_BEFORE=${preparedHead}\nPREP_BRANCH=pr-123-prep\n`,
      );
      writeFileSync(
        join(worktree, ".local/gates.env"),
        `PR_NUMBER=123\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${localHead}\n`,
      );
      writeFileSync(join(worktree, ".local/prep.md"), "Prepared fixture.\n");
    };
    prepare(head);
    const initial = {
      // The CLI locator can use an adapter's numeric id; REST and GraphQL expose
      // the authoritative pair independently of that projection.
      repo: {
        id: "R_kgDOQb6kRw" as string | number,
        url: "https://github.com/fixture/repo",
        nameWithOwner: "fixture/repo",
      },
      repoAuthority: {
        id: 1103012935,
        node_id: "R_kgDOQb6kRw",
        name: "repo",
        owner: { login: "fixture", type: "User" },
        full_name: "fixture/repo",
        html_url: "https://github.com/fixture/repo",
        permissions: { admin: true },
        squash_merge_commit_title: "PR_TITLE",
        squash_merge_commit_message: "PR_BODY",
      } as Record<string, unknown>,
      repoAuthorityUnavailable: false,
      repoGraphql: {
        id: "R_kgDOQb6kRw",
        databaseId: 1103012935,
        url: "https://github.com/fixture/repo",
        nameWithOwner: "fixture/repo",
      },
      pr: {
        id: "fixture-pr",
        number: 123,
        url: "https://github.com/fixture/repo/pull/123",
        state: "OPEN",
        headRefOid: head,
        headRefName: "topic",
        baseRefName: "main",
        isDraft: false,
        author: { login: "fixture-contributor", __typename: "User" },
        mergeCommit: null as { oid: string } | null,
        autoMergeRequest: null as { mergeMethod: string } | null,
        isInMergeQueue: false,
        isMergeQueueEnabled: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      },
      mode: "success",
      quotaAt: "",
      quotaAfterObservations: 0,
      quotaTriggered: false,
      quotaFailuresRemaining: null as number | null,
      // Preserve GraphQL lifecycle fixtures through an explicit unsupported REST policy.
      restPolicy: "classic",
      restReadFailure: "",
      restDispatchChange: "",
      pooledMergeBlocked: false,
      restReadFailuresRemaining: 0,
      restReadFailureAtMainReads: [] as number[],
      restRequiredApp: 15368 as number | null,
      restContexts: ["CI"],
      restCheckApp: 15368,
      restChecks: "pass",
      restFailedContext: "",
      restDuplicate: "",
      restSuite: "pass",
      restUnseenSuite: "",
      restAdvanceMain: false,
      restMainFault: "",
      restMainFaultAfterReads: 0,
      restMainReads: 0,
      restMainAdvance: null as null | {
        boundary: "before-evidence" | "during-evidence";
        observed: boolean;
        main: string;
      },
      restObservation: null as null | {
        pr?: Record<string, unknown>;
        advanceMain?: boolean;
        gates?: string;
      },
      restMergePayload: null as null | {
        sha: string;
        merge_method: string;
        commit_message: string;
      },
      graphqlMergePayloads: [] as Array<{
        pullRequestId: string;
        expectedHeadOid: string;
        mergeMethod: string;
        commitBody: string;
      }>,
      landing: "requested",
      reads: 0,
      observationReads: 0,
      settlementSleeps: [] as number[],
      observations: [] as Array<{
        pr?: Record<string, unknown>;
        main?: string;
        invalid?: boolean;
        unavailable?: boolean;
        advanceMain?: boolean;
        advanceAfterRead?: boolean;
        reportedMain?: string;
      }>,
      mainAdvances: [] as string[],
      calls: [] as string[][],
      nodeArgs: [] as string[],
      mutations: 0,
      cancellations: 0,
      cancellation: "success",
      mergeBody: null as string | null,
      previewBody: "Fixture body",
      previewHeadline: "Configured squash headline (#123)" as string | null,
      tamperMergeBody: false,
      issueComments: [
        {
          id: 1,
          body: `<!-- clawsweeper-review-version item=123 reviewed_at=${new Date().toISOString()} sha=${head} source_revision=${"b".repeat(64)} lease_owner=github-run-1 lease_comment_id=1 v=1 -->

<!-- clawsweeper-review item=123 -->`,
          user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
      issueCommentsAfterFirst: null as null | Array<{
        id: number;
        body: string;
        user: { id: number; login: string; type: string };
      }>,
      issueCommentReads: 0,
      tamperCorrectionAtFinalReview: false,
      issueCommentsErrorAt: 0,
      comments: [] as { body: string; html_url: string }[],
      posts: 0,
      invalid: false,
      unavailable: false,
      stale: false,
      drift: false,
      crash: "",
      comment: "success",
      admin: false,
      audit: false,
      gates: "pass",
      requiredCheckName: "CI",
      refusalCapture: "error: string rewrite protection blocked unsafe input\n",
      ciExit: 0,
      duringChecks: null as null | {
        head?: string;
        preparedHead?: string;
        artifact?: string;
        artifactContents?: string;
        bodyPath?: string;
        receiptField?: "LOCAL_PREP_HEAD_SHA" | "PREP_HEAD_SHA";
      },
      review: true,
      ready: true,
      cleanup: "",
      cleanupHead: "",
      operator: "fixture-operator",
    };
    const statePath = join(root, "server.json");
    const save = (state: typeof initial) => {
      writeFileSync(statePath, JSON.stringify(state));
      if (!state.review) {
        const file = join(worktree, ".local/review.json");
        writeFileSync(
          file,
          JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), docs: "invalid" }),
        );
      }
      if (!state.ready) {
        const file = join(worktree, ".local/review.json");
        const review = JSON.parse(readFileSync(file, "utf8"));
        review.recommendation = "NEEDS WORK";
        writeFileSync(file, JSON.stringify(review));
      }
    };
    const state = (): typeof initial => JSON.parse(readFileSync(statePath, "utf8"));
    save(initial);
    const gh = join(root, "gh.mjs");
    writeFileSync(
      gh,
      `
import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
const [route,...args]=process.argv.slice(2);
const file=process.env.FIXTURE_STATE;
const s=JSON.parse(fs.readFileSync(file,"utf8"));
const git=(args,input)=>execFileSync("git",["-c","commit.gpgsign=false","-c","core.hooksPath=/dev/null",...args],{cwd:process.env.FIXTURE_REPO,input,encoding:"utf8"}).trim();
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const out=(value)=>{
  const body=typeof value==="string"?value:JSON.stringify(value);
  const writerQuery=args.includes("--include")&&args.includes("graphql")&&args.some(arg=>/^query=\\s*query\\b/.test(arg));
  console.log(writerQuery&&typeof value!=="string"?"HTTP/2.0 200 OK\\n\\n"+body:body);
};
const fail=(text)=>{save();console.error(text);process.exit(1)};
if(route==="watch") {
  if(args[1]!==s.pr.headRefOid) fail("stale CI head");
  process.exit(s.ciExit);
}
if(route==="sleep") {s.settlementSleeps.push(Number(args[0]));save();process.exit(0);}
s.nodeArgs=process.execArgv;
s.calls.push([route,...args]);save();
if(args.some(arg=>arg.includes("{owner}")||arg.includes("{repo}"))) fail("protected unresolved repository placeholder");
const main=()=>git(["--git-dir="+process.env.FIXTURE_REMOTE,"rev-parse","refs/heads/main"]);
const quota=()=>{
  s.quotaTriggered=true;
  if(args[0]==="pr") fail("GraphQL: API rate limit already exceeded for user ID 123.");
  out({data:null,errors:[{type:"RATE_LIMITED",message:"API rate limit exceeded for fixture-operator."}]});
  fail("gh: API rate limit exceeded for fixture-operator. (RATE_LIMITED)");
};
const postComment=(body)=>{
  s.posts++;
  if(s.cleanup==="absent") git(["push","-q","origin",":refs/heads/topic"]);
  if(s.cleanup==="advanced") {
    s.cleanupHead=git(["commit-tree",git(["rev-parse",s.pr.headRefOid+"^{tree}"]),"-p",s.pr.headRefOid],"Branch advance\\n");
    git(["push","-q","origin",s.cleanupHead+":refs/heads/topic"]);
  }
  const url=s.pr.url+"#issuecomment-1";
  if(s.comment!=="rejected") s.comments.push({body,html_url:url});
  save();
  if(s.comment!=="success") fail("comment response lost");
  return url;
};
if(s.restMainReads>0&&args[0]==="api"&&args.includes("repos/fixture/repo/pulls/123")&&
  (s.restReadFailuresRemaining>0||s.restReadFailureAtMainReads.includes(s.restMainReads))) {
  if(s.restReadFailuresRemaining>0) s.restReadFailuresRemaining--;
  s.restReadFailureAtMainReads=s.restReadFailureAtMainReads.filter(read=>read!==s.restMainReads);
  const primary=s.restReadFailure==="core";
  out("HTTP/2.0 403 Forbidden\\nX-RateLimit-Resource: core\\nX-RateLimit-Remaining: "+(primary?"0":"4999")+"\\n\\n"+
    JSON.stringify({message:primary?"API rate limit exceeded for fixture-operator.":s.restReadFailure==="secondary"?"You have exceeded a secondary rate limit.":"Resource not accessible by integration"}));
  fail("gh: synthetic REST read rejected (HTTP 403)");
}
const quotaRead=s.quotaAt==="checks"&&args[0]==="pr"&&args[1]==="checks"||
  s.quotaAt==="preview"&&args.some(arg=>arg.includes("viewerMergeBodyText"))||
  s.quotaAt==="observe"&&s.observationReads>=s.quotaAfterObservations&&args.includes("graphql")&&!args.includes("--input")&&!args.some(arg=>arg.includes("viewerMergeBodyText"));
if(quotaRead&&s.quotaFailuresRemaining!==0) {
  if(s.quotaFailuresRemaining!==null) s.quotaFailuresRemaining--;
  quota();
}
const restMerge=args[0]==="api"&&args.includes("repos/fixture/repo/pulls/123/merge");
const graphqlMerge=args[0]==="api"&&args.includes("graphql")&&args.includes("--input");
const restCheckRuns=()=>{
  if(["missing","status-only"].includes(s.restChecks)) return [];
  const check={id:1,head_sha:s.pr.headRefOid,name:s.restContexts[0],status:"completed",conclusion:s.gates==="pass"?"success":"failure",
    started_at:"2026-09-20T00:00:00Z",check_suite:{id:10},app:{id:s.restCheckApp,slug:s.restCheckApp===15368?"github-actions":"custom-ci"}};
  if(s.restUnseenSuite==="partial-pending") return [check,{...check,id:2,name:"detect-changes",check_suite:{id:2}}];
  if(!s.restDuplicate) return s.restContexts.map((name,index)=>({...check,id:index+1,name,check_suite:{id:10+index},
    conclusion:name===s.restFailedContext?"failure":check.conclusion}));
  return [{...check,conclusion:"failure"},{...check,id:2,check_suite:{id:20},
    started_at:s.restDuplicate==="missing-time"?null:s.restDuplicate==="same-time"?check.started_at:"2026-09-20T00:01:00Z"}];
};
const restCheckSuites=()=>{
  const suites=restCheckRuns().map(check=>{
    const running=s.restSuite==="rerunning"||(s.restUnseenSuite==="partial-pending"&&check.check_suite.id===2);
    return {id:check.check_suite.id,head_sha:s.pr.headRefOid,app:check.app,
      status:running?"in_progress":"completed",conclusion:running?null:check.conclusion};
  });
  if(s.restUnseenSuite&&s.restUnseenSuite!=="partial-pending") {
    const empty=s.restUnseenSuite.startsWith("queued-empty");
    const pending=empty||["pending","other-app"].includes(s.restUnseenSuite);
    const failed=["failed","irrelevant-failure"].includes(s.restUnseenSuite);
    for(const id of s.restUnseenSuite==="labeler"?[30,31]:[30]) suites.push({id,head_sha:s.pr.headRefOid,
      app:{id:s.restUnseenSuite==="other-app"?999:s.restCheckApp,slug:s.restUnseenSuite==="other-app"?"another-app":s.restCheckApp===15368?"github-actions":"custom-ci"},
      status:empty?"queued":pending?"in_progress":"completed",conclusion:pending?null:failed?"failure":"skipped",
      updated_at:s.restUnseenSuite==="missing-version"?undefined:"2026-09-20T00:01:00Z",
      latest_check_runs_count:s.restUnseenSuite==="missing-count"?undefined:empty?0:["failed","hidden-skipped"].includes(s.restUnseenSuite)?1:3});
  }
  return suites;
};
const advanceMain=()=>{
  const parent=main();
  const next=git(["--git-dir="+process.env.FIXTURE_REMOTE,"commit-tree",git(["--git-dir="+process.env.FIXTURE_REMOTE,"rev-parse",parent+"^{tree}"]),"-p",parent],"Remote advance\\n");
  git(["--git-dir="+process.env.FIXTURE_REMOTE,"update-ref","refs/heads/main",next,parent]);
  s.mainAdvances.push(next);
};
if(args[0]==="browse") out(s.repo.url);
else if(args[0]==="repo") out(args.includes("--jq")?s.repo.nameWithOwner:s.repo);
else if(args[0]==="api"&&args.includes("rate_limit")) out({resources:{graphql:{remaining:0,limit:5000,reset:1900000000},core:{remaining:4999,limit:5000,reset:1900000000}}});
else if(args[0]==="api"&&args.some(arg=>new RegExp("^repos/[^/]+/[^/]+$").test(arg))) {
  if(!args.includes("Cache-Control: max-age=0")) fail("missing live repository header");
  if(!args.includes("--hostname")) fail("missing repository hostname");
  if(s.repoAuthorityUnavailable) fail("repository metadata unavailable");
  if(s.restDispatchChange) {
    const retained=spawnSync("git",["show","refs/openclaw/pr-merge-outcomes/123:outcome.json"],{cwd:process.env.FIXTURE_REPO,encoding:"utf8"});
    if(retained.status===0) {
      const intent=JSON.parse(retained.stdout);
      if(intent.phase==="intent"&&intent.accepted===false) {
        if(s.restDispatchChange==="identity") s.pr.headRefOid=git(["rev-parse",s.pr.headRefOid+"^"]);
        if(s.restDispatchChange==="policy") s.restContexts=["Reconfigured CI"];
        s.restDispatchChange="";save();
      }
    }
  }
  out(args.includes("--include")?"HTTP/2.0 200 OK\\n\\n"+JSON.stringify(s.repoAuthority):s.repoAuthority);
}
else if(args[0]==="api"&&args.includes("user")) {
  if(route==="direct"&&JSON.stringify(args)===JSON.stringify(["api","--hostname","github.com","user","--include"])) out("HTTP/2.0 200 OK\\n\\n"+JSON.stringify({login:s.operator}));
  else out("relay-reader");
}
else if(args[0]==="api"&&args.includes("repos/fixture/repo/pulls/123")) {
  if(s.repoAuthorityUnavailable) fail("repository metadata unavailable");
  if(s.restObservation&&s.quotaTriggered) {
    if(s.restObservation.pr) Object.assign(s.pr,s.restObservation.pr);
    if(s.restObservation.advanceMain) advanceMain();
    if(s.restObservation.gates) s.gates=s.restObservation.gates;
    s.restObservation=null;save();
  }
  const record={node_id:s.pr.id,number:s.pr.number,html_url:s.pr.url,title:"Fixture repair",body:s.previewBody,
    state:s.pr.state==="OPEN"?"open":"closed",merged:s.pr.state==="MERGED",merged_at:s.pr.state==="MERGED"?"2026-09-20T00:00:00Z":null,
    merge_commit_sha:s.pr.mergeCommit?.oid??null,draft:s.pr.isDraft,
    auto_merge:s.pr.autoMergeRequest?{merge_method:s.pr.autoMergeRequest.mergeMethod.toLowerCase()}:null,
    head:{sha:s.pr.headRefOid,ref:s.pr.headRefName,repo:s.repoAuthority},base:{ref:s.pr.baseRefName,sha:main(),repo:s.repoAuthority},
    user:{login:s.pr.author.login,type:s.pr.author.__typename},
    mergeable:s.pr.mergeable==="UNKNOWN"?null:s.pr.mergeable==="MERGEABLE",
    mergeable_state:s.pooledMergeBlocked&&!args.includes("--include")?"blocked":s.pr.mergeStateStatus.toLowerCase()};
  out(args.includes("--include")?"HTTP/2.0 200 OK\\n\\n"+JSON.stringify(record):record);
}
else if(args[0]==="api"&&args.includes("repos/fixture/repo/git/ref/heads/main")) {
  s.restMainReads++;
  if(s.restMainAdvance&&s.pr.state==="OPEN") {
    const retained=spawnSync("git",["show","refs/openclaw/pr-merge-outcomes/123:outcome.json"],{cwd:process.env.FIXTURE_REPO,encoding:"utf8"});
    if(retained.status===0) {
      const intent=JSON.parse(retained.stdout);
      if(intent.phase==="intent"&&intent.accepted===false) {
        if(s.restMainAdvance.boundary==="before-evidence"||s.restMainAdvance.observed) {
          git(["push","-q","origin",s.restMainAdvance.main+":refs/heads/main"]);
          s.restMainAdvance=null;
        } else s.restMainAdvance.observed=true;
      }
    }
  }
  const reference={ref:"refs/heads/main",object:{type:"commit",sha:main()}};
  if(s.restMainReads>s.restMainFaultAfterReads) {
    if(s.restMainFault==="wrong-ref") reference.ref="refs/tags/main";
    if(s.restMainFault==="wrong-type") reference.object.type="tag";
    if(s.restMainFault==="missing-object") delete reference.object;
    if(s.restMainFault==="invalid-sha") reference.object.sha="not-a-commit";
  }
  out(reference);
  if(s.pr.state==="MERGED"&&s.restAdvanceMain) {s.restAdvanceMain=false;advanceMain();}
}
else if(args[0]==="api"&&args.includes("repos/fixture/repo/branches/main/protection")) {
  if(s.restPolicy==="classic") out('HTTP/2.0 200 OK\\n\\n{}');
  else {out('HTTP/2.0 404 Not Found\\n\\n{"message":"Branch not protected"}');fail("gh: Branch not protected (HTTP 404)");}
}
else if(args[0]==="api"&&args.some(arg=>arg.startsWith("repos/fixture/repo/rules/branches/main?"))) {
  out(s.restPolicy==="missing"?[null]:[[
    {type:"required_status_checks",parameters:{required_status_checks:s.restContexts.map(context=>({context,integration_id:s.restRequiredApp}))}},
    ...(s.restPolicy==="queue"?[{type:"merge_queue"}]:s.restPolicy==="unsupported"?[{type:"workflows"}]:[])
  ]]);
}
else if(args[0]==="api"&&args.some(arg=>arg.startsWith("repos/fixture/repo/check-suites/"))) {
  const endpoint=args.find(arg=>arg.startsWith("repos/fixture/repo/check-suites/"));
  const id=Number(endpoint.split("/")[4]);
  const suite=restCheckSuites().find(suite=>suite.id===id);
  if(!suite) fail("unknown check suite");
  if(endpoint.includes("/check-runs?")) {
    const names=s.restUnseenSuite.startsWith("queued-empty")?[]:["failed","hidden-skipped"].includes(s.restUnseenSuite)?["CI"]:["label","label-issues","backfill-pr-labels"];
    const checks=names.map((name,index)=>({id:id*100+index,head_sha:s.pr.headRefOid,name,app:suite.app,check_suite:{id},
      status:"completed",conclusion:suite.conclusion,started_at:"2026-09-20T00:00:00Z"}));
    out([{total_count:checks.length+(s.restUnseenSuite==="incomplete-suite"?1:0),check_runs:checks}]);
  } else out(s.restUnseenSuite==="changed-suite"?{...suite,updated_at:"2026-09-20T00:02:00Z"}:["changed-count","queued-empty-drift"].includes(s.restUnseenSuite)?{...suite,latest_check_runs_count:4}:suite);
}
else if(args[0]==="api"&&args.some(arg=>arg.includes("/check-runs?"))) {
  const endpoint=args.find(arg=>arg.includes("/check-runs?"));
  const context=new URL(endpoint,"https://github.com").searchParams.get("check_name");
  const checks=restCheckRuns().filter(check=>context===null||check.name===context);
  out([{total_count:checks.length,check_runs:checks}]);
}
else if(args[0]==="api"&&args.some(arg=>arg.includes("/status?"))) {
  const statuses=["bound-status","status-only","wrong-app-status","failed-status"].includes(s.restChecks)?[{id:2,context:"CI",state:s.restChecks==="failed-status"?"failure":"success"}]:[];
  out([{total_count:statuses.length,sha:s.pr.headRefOid,state:s.restChecks==="inconsistent-status"?"failure":statuses[0]?.state??"pending",statuses}]);
}
else if(args[0]==="api"&&args.some(arg=>arg.includes("/check-suites?"))) {
  const suites=restCheckSuites();
  const page={total_count:suites.length,check_suites:suites};
  out(args.includes("--slurp")?[page]:page);
}
else if(args[0]==="api"&&args.some(arg=>arg.startsWith("repos/fixture/repo/actions/runs?"))) {
  const runs=restCheckRuns().map((check,index)=>({id:100+index,head_sha:s.pr.headRefOid,check_suite_id:check.check_suite.id,
    workflow_id:index===1&&s.restDuplicate==="other-workflow"?43:42,event:index===1&&s.restDuplicate==="other-event"?"push":"pull_request"}));
  if(s.restDuplicate==="missing-mapping") runs.pop();
  if(s.restDuplicate==="ambiguous-mapping") runs.push({...runs[1],id:103,workflow_id:44});
  out([{total_count:runs.length,workflow_runs:runs}]);
}
else if(args[0]==="pr"&&args[1]==="checks") {
  if(s.duringChecks?.bodyPath) fs.writeFileSync(s.duringChecks.bodyPath,"Changed later");
  if(s.duringChecks?.head) s.pr.headRefOid=s.duringChecks.head;
  if(s.duringChecks?.preparedHead) git(["update-ref","refs/heads/pr-123-prep",s.duringChecks.preparedHead]);
  if(s.duringChecks?.artifact) {
    const path=process.env.FIXTURE_REPO+"/.worktrees/pr-123/.local/"+s.duringChecks.artifact;
    if(typeof s.duringChecks.artifactContents==="string") fs.writeFileSync(path,s.duringChecks.artifactContents);
    else fs.appendFileSync(path,"\\n# changed during checks\\n");
  }
  if(s.duringChecks?.receiptField) { const receipt=process.env.FIXTURE_REPO+"/.worktrees/pr-123/.local/prep.env"; fs.writeFileSync(receipt,fs.readFileSync(receipt,"utf8").replace(new RegExp("^"+s.duringChecks.receiptField+"=.*$","m"),s.duringChecks.receiptField+"="+main())); }
  out([{name:s.requiredCheckName,bucket:s.gates,state:s.gates==="pass"?"SUCCESS":"FAILURE"}]);}
else if(args[0]==="pr"&&args[1]==="view") {
  const fields=args[args.indexOf("--json")+1].split(",");
  if(fields.includes("headRefName")&&!fields.includes("headRefOid")) fail("missing live cleanup metadata");
  const pr={...s.pr,changedFiles:0,files:[],baseRefOid:main(),baseRepository:s.repoGraphql,
    headRepository:{id:s.repoGraphql.id,name:"repo",nameWithOwner:"fixture/repo",url:s.repo.url},headRepositoryOwner:{login:"fixture"}};
  if(route==="path"&&s.stale) {pr.state="OPEN";pr.mergeCommit=null;}
  if(args.includes("--jq")) {const q=args[args.indexOf("--jq")+1];out(q===".state"?pr.state:q===".mergeCommit.oid"?pr.mergeCommit?.oid??"null":pr.url);}
  else out(pr);
} else if((args[0]==="pr"&&args[1]==="merge")||restMerge||graphqlMerge) {
  if(s.mode==="octopool-refusal") {
    if(process.env.OCTOPOOL_DIAGNOSTICS!=="1"||!args.includes("--subject")) fail("missing protected merge publication inputs");
    save();process.stderr.write(s.refusalCapture);process.exit(1);
  }
  s.mutations++;
  if(s.quotaAt==="mutation") {s.quotaAt="observe";quota();}
  if(restMerge) {
    if(!args.includes("PUT")||args[args.indexOf("--input")+1]!=="-") fail("invalid REST merge request");
    s.restMergePayload=JSON.parse(fs.readFileSync(0,"utf8"));
    if(s.restMergePayload.sha!==s.pr.headRefOid||s.restMergePayload.merge_method!=="squash") fail("unpinned REST merge request");
    s.mergeBody=s.restMergePayload.commit_message;
  }
  if(graphqlMerge) {
    const payload=JSON.parse(fs.readFileSync(0,"utf8"));
    if(payload.query!=="mutation PullRequestMerge($input:MergePullRequestInput!){mergePullRequest(input:$input){clientMutationId}}") fail("invalid direct merge mutation");
    const input=payload.variables.input;
    if(JSON.stringify(Object.keys(input).sort())!==JSON.stringify(["commitBody","expectedHeadOid","mergeMethod","pullRequestId"])||
      input.pullRequestId!==s.pr.id||input.expectedHeadOid!==s.pr.headRefOid||input.mergeMethod!=="SQUASH"||typeof input.commitBody!=="string") fail("invalid pinned direct squash request");
    if(s.pr.isMergeQueueEnabled||s.pr.isInMergeQueue||s.pr.autoMergeRequest||s.admin) fail("special route reached direct merge");
    s.graphqlMergePayloads.push(input);
    s.mergeBody=input.commitBody;
  }
  if(args.includes("--body-file")) s.mergeBody=fs.readFileSync(args[args.indexOf("--body-file")+1],"utf8");
  if(args.includes("--disable-auto")) fail("unexpected cancellation");
  if(s.mode==="pending"||s.mode==="pending-error") {
    s.pr.autoMergeRequest={mergeMethod:"SQUASH"};s.pr.isInMergeQueue=s.pr.isMergeQueueEnabled;save();
    if(s.mode==="pending-error") fail("502 after enablement");
  } else {
    if(s.mode!=="unapplied") {
      let parent=main();
      if(s.mode==="advance-at-dispatch") {
        const sibling=git(["hash-object","-w","--stdin"],"advanced\\n");
        const owner=git(["rev-parse",parent+":owner.txt"]);
        const nextTree=git(["mktree"],"100644 blob "+owner+"\\towner.txt\\n100644 blob "+sibling+"\\tsibling.txt\\n");
        parent=git(["commit-tree",nextTree,"-p",parent],"Unrelated advance\\n");
      }
      let landed;
      if(args.includes("--rebase")||s.landing==="rebase") {
        const rebaseDir=process.env.FIXTURE_REPO+"/server-rebase";
        const sourceBase=git(["merge-base",parent,s.pr.headRefOid]);
        git(["worktree","add","-q","--detach",rebaseDir,s.pr.headRefOid]);
        git(["-C",rebaseDir,"rebase","--onto",parent,sourceBase]);
        landed=git(["-C",rebaseDir,"rev-parse","HEAD"]);
        git(["worktree","remove",rebaseDir]);
      } else {
        const tree=git(["merge-tree","--write-tree",parent,s.pr.headRefOid]);
        const parents=args.includes("--merge")?["-p",parent,"-p",s.pr.headRefOid]:["-p",parent];
        landed=git(["commit-tree",tree,...parents],"Landed\\n");
      }
      if(s.landing==="mismatch") landed=git(["commit-tree",git(["rev-parse",parent+"^{tree}"]),"-p",parent,...(args.includes("--merge")?["-p",s.pr.headRefOid]:[])],"Mismatched receipt\\n");
      git(["push","-q","origin",landed+":refs/heads/main"]);
      s.landed=landed;
      if(s.mode!=="applied-open"||s.mutations>1) {s.pr.state="MERGED";s.pr.mergeCommit={oid:landed};}
      save();
    }
    if(s.crash==="dispatch") {save();process.kill(Number(process.env.FIXTURE_LEADER),"SIGKILL");process.exit(1);}
    if(s.mutations===1&&["applied-open","applied-merged","unapplied"].includes(s.mode)) fail("non-200 OK status code: 502 Bad Gateway");
  }
  if(restMerge) out({merged:true,sha:s.pr.mergeCommit?.oid});
  if(graphqlMerge) out({data:{mergePullRequest:{clientMutationId:null}}});
} else if(args.includes("graphql")&&args.some(arg=>arg.includes("disablePullRequestAutoMerge("))) {
  const record=JSON.parse(git(["show","refs/openclaw/pr-merge-outcomes/123:outcome.json"]));
  if(record.cancellation?.state!=="requested"||!args.includes("id="+s.pr.id)) fail("cancellation intent not retained before dispatch");
  s.cancellations++;
  if(s.cancellation==="rejected") fail("cancellation rejected");
  s.pr.autoMergeRequest=null;
  if(s.cancellation==="merged") {
    const parent=main();
    const landed=git(["commit-tree",git(["merge-tree","--write-tree",parent,s.pr.headRefOid]),"-p",parent],"Concurrent merge\\n");
    git(["push","-q","origin",landed+":refs/heads/main"]);
    s.pr.state="MERGED";s.pr.mergeCommit={oid:landed};
  }
  save();
  if(s.cancellation==="lost") fail("cancellation response lost");
  out({data:{disablePullRequestAutoMerge:{pullRequest:{id:s.pr.id}}}});
} else if(args.includes("graphql")&&args.some(arg=>arg.includes("addComment("))) {
  out({data:{addComment:{commentEdge:{node:{url:postComment(args.find(arg=>arg.startsWith("body="))?.slice(5))}}}}});
} else if(args.includes("graphql")) {
  s.reads++;save();
  if(s.unavailable) fail("metadata unavailable");
  if(s.invalid) {out({data:{repository:{}}});process.exit(0);}
  if(args.some(x=>x.includes("viewerMergeBodyText"))) {out({data:{repository:{pullRequest:{...s.pr,viewerMergeBodyText:s.pooledMergeBlocked&&!args.includes("--include")?"Pooled viewer body":s.previewBody,...(args.some(x=>x.includes("viewerMergeHeadlineText"))?{viewerMergeHeadlineText:s.previewHeadline}:{})}}}});}
  else {
    if(!args.includes("Cache-Control: max-age=0")) fail("missing independent fresh merge observation");
    if(args.find(arg=>arg.startsWith("query="))!==${JSON.stringify(landingSnapshotQuery)}) fail("landing snapshot query is not supported by the shipped Octopool shim");
    s.observationReads++;
    const step=s.observations.shift();
    if(step?.pr) Object.assign(s.pr,step.pr);
    if(step?.main) git(["push","-q","--force","origin",step.main+":refs/heads/main"]);
    if(step?.advanceMain) advanceMain();
    if(step?.unavailable) fail("metadata unavailable");
    if(step?.invalid) {save();out({data:{repository:{}}});process.exit(0);}
    const {headRefName,...pr}=s.pr;if(s.drift&&s.reads%2===0) pr.baseRefName="changed";
    if(s.pooledMergeBlocked&&!args.includes("--include")) pr.mergeStateStatus="BLOCKED";
    const repository={...s.repoGraphql,ref:{target:{oid:step?.reportedMain??main()}},pullRequest:pr};
    out({data:{repository}});
    if(step?.advanceAfterRead) advanceMain();
  }
} else if(args.some(x=>x.includes("/comments"))) {
  if(args.includes("POST")) {
    out(postComment(args.find(x=>x.startsWith("body="))?.slice(5)));
  } else {
    if(!args.includes("Cache-Control: max-age=0")) fail("missing live comment header");
    s.issueCommentReads++;
    if(s.issueCommentReads>1&&s.tamperCorrectionAtFinalReview) fs.appendFileSync(process.env.FIXTURE_REPO+"/.worktrees/pr-123/.local/correction-review.json","\\n");
    if(s.tamperMergeBody) {
      const local=process.env.FIXTURE_REPO+"/.worktrees/pr-123/.local/";
      for(const name of fs.readdirSync(local).filter(name=>name.startsWith("merge-body."))) fs.writeFileSync(local+name,"Tampered");
    }
    if(s.issueCommentReads===s.issueCommentsErrorAt) fail("comment API unavailable");
    if(s.issueCommentReads>1&&s.issueCommentsAfterFirst) s.issueComments=s.issueCommentsAfterFirst;
    save();
    out([[...s.issueComments,...s.comments]]);
  }
} else if(args[0]==="api"&&args.some(arg=>arg.startsWith("repos/fixture/repo/commits?"))) {
  const query=new URL(args.find(arg=>arg.startsWith("repos/fixture/repo/commits?")),"https://github.com").searchParams;
  const commits=git(["rev-list","--max-count="+query.get("per_page"),query.get("sha")]).split("\\n");
  out(commits.map(oid=>({sha:oid,commit:{author:{name:git(["show","-s","--format=%an",oid]),email:git(["show","-s","--format=%ae",oid])}},author:{login:s.pr.author.login,type:"User"}})));
} else if(args.some(x=>x.includes("/commits/"))) {
  if(s.audit) fail("audit unavailable");
  out({parents:[{sha:git(["rev-parse",s.pr.mergeCommit.oid+"^1"])}]});
} else fail("unexpected gh "+args.join(" "));
save();
`,
    );
    const shell = join(root, "invoke.sh");
    writeFileSync(
      shell,
      `#!/usr/bin/env bash
set -euo pipefail
script_parent_dir="$FIXTURE_SCRIPTS"
source "$script_parent_dir/lib/plain-gh.sh"
source "$script_parent_dir/pr-lib/worktree.sh"
source "$script_parent_dir/pr-lib/operation-lock.sh"
source "$script_parent_dir/pr-lib/common.sh"
source "$script_parent_dir/pr-lib/merge.sh"
source "$script_parent_dir/pr-lib/review.sh"
source "$script_parent_dir/pr-lib/gates.sh"
repo_root() { printf '%s\\n' "$FIXTURE_REPO"; }
ensure_gh_api_auth() { :; }
verify_prep_branch_matches_prepared_head() { [ "$(command git rev-parse HEAD)" = "$2" ]; }
node() { if [[ "$1" == */watch-pr-ci.mjs ]]; then shift; command node "$FIXTURE_GH" watch "$@"; else command node "$@"; fi; }
pr_gh() {
  if [ "$1" = commit-authors ] || { [ "$1" = pr ] && [ "$2" = view ]; }; then pr_gh_run read "$@";
  else command node "$FIXTURE_GH" path "$@"; fi
}
pr_gh_plain() {
  if [ "$1" = repo-authority ] || [ "$1" = issue-comments ] || [ "$1" = writer-login ]; then
    pr_gh_run plain "$@"
  elif { [ "$1" = pr ] && [ "$2" = view ]; } ||
    { [ "$FIXTURE_REAL_GH" = true ] && { [ "$1" = pr ] && { [ "$2" = checks ] || [ "$2" = merge ]; } || [[ " $* " == *" graphql "* ]]; }; }; then
    pr_gh_run "\${pr_gh_quota_route:-plain}" "$@"
  else
    command node "$FIXTURE_GH" direct "$@"
  fi
}
# Skip only admission settlement delays; preserve the operation lock's short sleeps.
sleep() { if [ "$#" = 1 ] && { [ "$1" = 1 ] || [ "$1" = 2 ]; }; then command node "$FIXTURE_GH" sleep "$1"; else command sleep "$@"; fi; }
verify_crabbox_admin_merge_bypass() {
  [ "$(command jq -r .admin "$FIXTURE_STATE")" = true ] || return 1
  command jq --arg main "$(git --git-dir="$FIXTURE_REMOTE" rev-parse refs/heads/main)" '{mainSha:$main,crabboxCheckUrl:"fixture",ciGateUrl:"fixture"}' "$FIXTURE_STATE" > .local/merge-crabbox-bypass.json
}
# Fault the Git boundary, not the outcome owner: crash after intent CAS, or
# reject later receipt writes. All successful object/ref operations are real.
pr_git() {
  if [ "$1" = update-ref ] && [ "\${3-}" = refs/openclaw/pr-merge-outcomes/123 ]; then
    local crash
    crash=$(command jq -r .crash "$FIXTURE_STATE")
    if [ "$crash" = receipt ] && command git show-ref --verify --quiet "$3"; then return 1; fi
    if [ "$crash" = successor ]; then
      command git update-ref "$3" "$(printf 'successor\\n' | command git hash-object -w --stdin)"
    fi
    command git "$@" || return
    if [ "$crash" = capture ]; then
      local attempt
      attempt=$(command git show "$4:outcome.json" | command jq -r .attempt)
      ln -s "$FIXTURE_ROOT/capture-target" ".local/merge-output.$attempt.log"
    fi
    if [ "$crash" = intent ]; then kill -KILL "$$"; fi
    return
  fi
  command git "$@"
}
export FIXTURE_LEADER="$$"
acquire_pr_operation_lock 123
begin_pr_operation_validation_phase
if [ "\${9:-}" = verify ]; then
  merge_verify 123 '{"replacementHead":"","autoMergeRequested":false,"qualifiedRefusal":false,"observation":null}'
elif [ -n "\${5:-}" ]; then
  merge_complete 123 "$5"
else
  merge_run 123 "\${1:-false}" "\${2:-}" "\${3:-}" "\${4:-}" "\${6:-}" "\${7:-false}" "\${8:-}"
fi
`,
    );
    chmodSync(shell, 0o755);
    const bin = join(root, "bin");
    mkdirSync(bin);
    // The fixture isolates its environment; carry the test runner's Node 24
    // shutdown policy through shell-launched helpers as well as the supervisor.
    writeFileSync(
      join(bin, "node"),
      `#!/bin/sh\nexec "$FIXTURE_NODE" ${nodeArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "gh"), '#!/bin/sh\nexec node "$FIXTURE_GH" direct "$@"\n', {
      mode: 0o755,
    });
    const tracePath = join(root, "git.trace.jsonl");
    const env = {
      ...gitEnv,
      PATH: `${bin}:${gitEnv.PATH}`,
      TMPDIR: root,
      // Reuse compiled owner modules across native children, never mutable fixture state.
      NODE_COMPILE_CACHE: template.compileCache,
      FIXTURE_STATE: statePath,
      FIXTURE_ROOT: root,
      FIXTURE_REPO: repo,
      FIXTURE_REMOTE: remote,
      FIXTURE_SCRIPTS: scripts,
      FIXTURE_GH: gh,
      FIXTURE_NODE: nodeExecutable,
      OPENCLAW_PR_MERGE_METHOD: "squash",
      OPENCLAW_PR_STRICT_DRIFT: "",
      // Only partial-clone cases consume trace evidence to reject implicit hydration.
      GIT_TRACE2_EVENT: promisor ? tracePath : undefined,
    };
    const run = (
      auto = false,
      cwd = repo,
      method = "squash",
      recoveryOid = "",
      replacementHead = "",
      bodyPath = "",
      completionOid = "",
      legacyDirectory = "",
      cancelAuto = false,
      refusalDirectory = "",
      verifyOnly = false,
    ) => {
      const result = spawnSync(
        nodeExecutable,
        [
          ...nodeArgs,
          join(scripts, "pr-lib/process-group-runner.mjs"),
          repo,
          shell,
          String(auto),
          recoveryOid,
          replacementHead,
          bodyPath,
          completionOid,
          legacyDirectory,
          String(cancelAuto),
          refusalDirectory,
          verifyOnly ? "verify" : "",
        ],
        {
          cwd,
          env: {
            ...env,
            FIXTURE_REAL_GH: String(Boolean(state().quotaAt || state().restReadFailure)),
            OPENCLAW_PR_MERGE_METHOD: method,
          },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      return { ...result, output: result.stdout + result.stderr };
    };
    const recover = () => {
      const read = spawnSync("git", ["rev-parse", "--verify", lockRef], {
        cwd: repo,
        env: gitEnv,
        encoding: "utf8",
      });
      if (read.status !== 0) {
        return false;
      }
      const oid = read.stdout.trim();
      const owner = git(["cat-file", "blob", oid]);
      const pgid = Number(/^pgid=(\d+)$/m.exec(owner)?.[1]);
      expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -euo pipefail; source "$1"; repo_root() { pwd; }; recover_pr_operation_lock 123 "$2" --confirmed-no-running-tools',
          "recover",
          join(scripts, "pr-lib/operation-lock.sh"),
          oid,
        ],
        { cwd: repo, env: gitEnv, encoding: "utf8" },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return true;
    };
    const advance = (owner = "after\n", sibling = "advanced\n") => {
      const parent = git(["--git-dir=" + remote, "rev-parse", "main"]);
      // Same-tree main advances must not become source commits within one clock second.
      const next = commit(tree(owner, sibling), [parent], "Main advance\n");
      git(["push", "-q", "origin", next + ":refs/heads/main"]);
      return next;
    };
    const replacePreparedHead = () => {
      const main = advance("conflicting main\n", "stable\n");
      const replacement = commit(tree("reviewed replacement\n"), [main]);
      git(["-C", worktree, "checkout", "-B", "pr-123-prep", replacement]);
      git([
        "push",
        "-q",
        "--force",
        "origin",
        `${replacement}:refs/pull/123/head`,
        `${replacement}:refs/heads/topic`,
      ]);
      prepare(replacement, main);
      const next = state();
      next.pr.headRefOid = replacement;
      next.issueComments[0]!.body = next.issueComments[0]!.body.replace(head, replacement);
      save(next);
      return replacement;
    };
    const ordinaryRead = () =>
      JSON.parse(
        execFileSync(
          nodeExecutable,
          [...nodeArgs, gh, "path", "pr", "view", "123", "--json", "state,headRefOid,mergeCommit"],
          { cwd: repo, env, encoding: "utf8" },
        ),
      );
    const record = () => JSON.parse(git(["show", outcomeRef + ":outcome.json"]));
    const captures = () =>
      readdirSync(join(worktree, ".local"))
        .filter((name) => /^merge-output(?:\..+)?\.log$/.test(name))
        .toSorted()
        .map((name) => [name, readFileSync(join(worktree, ".local", name), "utf8")] as const);
    const setPrivacyProvenance = (rewrite: string | null, access: string | null) => {
      const path = join(worktree, ".local/prep.env");
      let contents = readFileSync(path, "utf8");
      contents = contents.replace(
        /^PREP_REPLACED_HOSTED_ANCESTRY=.*\n/mu,
        rewrite === null ? "" : `PREP_REPLACED_HOSTED_ANCESTRY=${rewrite}\n`,
      );
      contents = contents.replace(
        /^PREP_AUTHOR_ACCESS=.*\n/mu,
        access === null ? "" : `PREP_AUTHOR_ACCESS=${access}\n`,
      );
      writeFileSync(path, contents);
    };
    return {
      root,
      repo,
      remote,
      worktree,
      base,
      head,
      sourceCommits,
      git,
      tree,
      commit,
      state,
      save,
      run,
      complete: (oid: string) => run(false, repo, "squash", "", "", "", oid),
      verify: () => run(false, repo, "squash", "", "", "", "", "", false, "", true),
      cancel: (oid: string) => run(false, repo, "squash", oid, "", "", "", "", true),
      recover,
      advance,
      record,
      captures,
      setPrivacyProvenance,
      prepare,
      replacePreparedHead,
      ordinaryRead,
      trace: () =>
        readFileSync(tracePath, "utf8")
          .trim()
          .split("\n")
          .map((line): { event: string; sid: string; argv?: string[] } => JSON.parse(line)),
    };
  }

  function expectNoProbeFetch(trace: ReturnType<ReturnType<typeof fixture>["trace"]>) {
    const probes = trace.filter(
      (event) =>
        event.event === "start" &&
        event.argv?.some((arg) => ["cat-file", "show", "merge-base"].includes(arg)),
    );
    expect(probes.length).toBeGreaterThan(0);
    expect(
      trace.filter(
        (event) =>
          event.event === "child_start" &&
          event.argv?.includes("fetch") &&
          probes.some((probe) => probe.sid === event.sid),
      ),
    ).toEqual([]);
  }

  function createLegacyRefusal(f: ReturnType<typeof fixture>) {
    const directory = join(f.root, "legacy-evidence");
    mkdirSync(directory);
    const capture = `X Pull request fixture/repo#123 is not mergeable: the merge commit cannot be cleanly created.
To have the pull request merged after all the requirements have been met, add the \`--auto\` flag.
Run the following to resolve the merge conflicts locally:
  gh pr checkout 123 && git fetch origin main && git merge origin/main
`;
    writeFileSync(join(f.worktree, ".local/merge-output.log"), capture);
    const files = Object.fromEntries(
      ["merge-output.log", "prep.env", "prep.md", "gates.env"].map((name) => {
        const contents = readFileSync(join(f.worktree, ".local", name), "utf8");
        writeFileSync(join(directory, name), contents);
        return [name, contents];
      }),
    );
    return {
      directory,
      files,
      oid: f.git(["hash-object", "--no-filters", join(directory, "merge-output.log")]),
    };
  }

  function reconciledMergeAfterCleanup(admin = false) {
    const f = fixture();
    f.save({ ...f.state(), mode: "applied-open", admin, gates: admin ? "fail" : "pass" });
    expect(f.run().status).toBe(1);
    f.recover();
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const reconciled = f.run();
    expect(reconciled.status, reconciled.output).toBe(0);
    expect(f.record().phase).toBe("merged");
    expect(f.state().posts).toBe(0);
    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["push", "-q", "origin", ":refs/heads/topic"]);
    return f;
  }

  return {
    fixture,
    expectNoProbeFetch,
    createLegacyRefusal,
    reconciledMergeAfterCleanup,
    outcomeRef,
    lockRef,
    describePosix,
    unknownProjection,
    supportsNoLazyFetch,
    scripts,
    nodeExecutable,
    gitEnv,
  };
}
