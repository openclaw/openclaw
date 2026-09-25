import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("trusted native readiness callers", () => {
  let f: ReturnType<typeof createMainRefreshFixture>;
  let apiFile: string;
  let callsFile: string;
  let prepared: string;
  beforeAll(() => {
    f = createMainRefreshFixture(tempDirs.make("pr-readiness-native-"));
    delete f.env.OPENCLAW_TESTBOX;
    f.env.OPENCLAW_PR_GATES_REMOTE = "github";
    f.configure({ hostedCi: "missing", requiredChecks: "pending" });
    const cli = f.env.OPENCLAW_GH_BIN!;
    renameSync(cli, `${cli}-delegate`);
    apiFile = join(f.root, "readiness-api.json");
    callsFile = join(f.root, "readiness-calls.jsonl");
    writeFileSync(apiFile, JSON.stringify({ policy: "all" }));
    writeFileSync(callsFile, "");
    writeFileSync(
      cli,
      `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
const apiFile=${JSON.stringify(apiFile)};
const api=JSON.parse(readFileSync(apiFile,'utf8'));
const controlFile=${JSON.stringify(join(f.root, "control.json"))};
const control=JSON.parse(readFileSync(controlFile,'utf8'));
const endpoint=args.find(a=>a==='user'||a.startsWith('repos/'));
if(args[0]==='api') appendFileSync(${JSON.stringify(callsFile)},JSON.stringify(args)+'\\n');
let value;
if(args[0]==='api' && endpoint?.includes('/contents/.github/ci-readiness.json?')) value={content:Buffer.from(JSON.stringify({version:1,mode:api.policy,pullRequests:[]})).toString('base64')};
else if(args[0]==='api' && endpoint==='user') {
  if(!args.includes('--include')) throw Error('writer identity bypassed');
  process.stdout.write('HTTP/2.0 200 OK\\n\\n'); value={login:'fixture',id:123};
} else if(args[0]==='api' && endpoint?.endsWith('/collaborators/fixture/permission')) value={permission:'write',user:{id:123}};
else if(args[0]==='api' && endpoint?.startsWith('repos/fixture/repo/labels/')) value={};
else if(args[0]==='api' && endpoint==='repos/fixture/repo/issues/42/labels' && args.includes('POST')) {
  const body=JSON.parse(readFileSync(args[args.indexOf('--input')+1],'utf8'));
  control.metadata.labels=body.labels.map(name=>({name}));
  writeFileSync(controlFile,JSON.stringify(control));
  api.label=body.labels[0];writeFileSync(apiFile,JSON.stringify(api));value={};
} else if(args[0]==='api' && endpoint?.includes('/issues/42/events?')) value=[{id:101,event:'labeled',actor:{login:'fixture',id:123},label:{name:api.label}}];
else {
  const result=spawnSync(${JSON.stringify(`${cli}-delegate`)},args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
}
console.log(JSON.stringify(value));
`,
    );
    chmodSync(cli, 0o755);
    const result = f.run("prepare-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"requested"');
    prepared = readFileSync(join(f.local, "gates.env"), "utf8");
  });

  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const configureApi = (policy: string) => {
    const api = JSON.parse(readFileSync(apiFile, "utf8"));
    writeFileSync(apiFile, JSON.stringify({ ...api, policy }));
  };

  it("automatically requests after verified publication and keeps the pending gate stamp", () => {
    expect(prepared).toContain("GATES_MODE=github_pending");
    expect(prepared).toContain(`HOSTED_GATES_TARGET_HEAD_SHA=${f.head}`);
    const written = calls().filter(
      (args) => args.includes("POST") && args.includes("repos/fixture/repo/issues/42/labels"),
    );
    expect(written).toHaveLength(1);
    expect(
      calls().some((args) =>
        args.includes(`repos/fixture/repo/contents/.github/ci-readiness.json?ref=${f.main}`),
      ),
    ).toBe(true);
    expect(
      calls()
        .filter((args) => args.includes("user"))
        .every((args) => args.includes("--include")),
    ).toBe(true);
  });

  it("a PR-controlled helper cannot replace the canonical/materialized writer on reentry", () => {
    configureApi("all");
    writeFileSync(
      join(f.worktree, "scripts/ci-readiness.mjs"),
      "throw Error('PR helper executed with credentials');\n",
    );
    const before = calls().filter((args) => args.includes("POST")).length;
    const refused = f.run("prepare-push", "bash", f.worktree);
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stderr).toContain("Refusing to run unreviewed wrapper code");
    expect(calls().filter((args) => args.includes("POST"))).toHaveLength(before);
    const result = f.run("prepare-push");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"attach"');
    expect(calls().filter((args) => args.includes("POST"))).toHaveLength(before);
    expect(readFileSync(join(f.worktree, "scripts/ci-readiness.mjs"), "utf8")).toContain(
      "PR helper executed",
    );
  });

  it("policy off retains ordinary preparation without writes", () => {
    configureApi("off");
    const before = calls().filter((args) => args.includes("POST")).length;
    const result = f.run("prepare-push");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"status":"disabled"');
    expect(calls().filter((args) => args.includes("POST"))).toHaveLength(before);
  });

  it.each([
    { state: "SUCCESS", deferred: true, expected: 0 },
    { state: "PENDING", deferred: true, expected: 0 },
    { state: "PENDING", deferred: false, expected: 1 },
    { state: "FAILURE", deferred: true, expected: 1 },
  ])(
    "keeps Security Review $state in the final predicate (deferred=$deferred)",
    ({ state, deferred, expected }) => {
      // gh exports the current CI CheckRun plus the independent same-name
      // Security Review StatusContext, not historical duplicate CI CheckRuns.
      const rows = [{ name: "openclaw/ci-gate", state: "SUCCESS", bucket: "pass" }];
      rows.push({
        name: "openclaw/ci-gate",
        state,
        bucket: state === "SUCCESS" ? "pass" : state === "PENDING" ? "pending" : "fail",
      });
      configureApi("off");
      f.configure({ hostedCi: "release", requiredCheckRows: rows });
      writeFileSync(
        join(f.local, "gates.env"),
        deferred ? prepared : prepared.replace("github_pending", "hosted_exact_or_recent_parent"),
      );
      const result = f.shell(
        `merge_verify 42 '{"replacementHead":"","autoMergeRequested":${deferred},"observation":null,"qualifiedRefusal":false}' || exit 1`,
      );
      expect(result.status, result.stdout + result.stderr).toBe(expected);
      if (state === "FAILURE") {
        expect(result.stderr).toContain("Required checks are failing");
      }
      if (state === "PENDING" && !deferred) {
        expect(result.stdout).toContain("Required checks are still pending");
      }
    },
  );

  it("retains verified publication on readiness failure without submitting another label", () => {
    configureApi("invalid");
    f.configure({ requiredCheckRows: undefined });
    writeFileSync(join(f.local, "gates.env"), prepared);
    const before = calls().filter((args) => args.includes("POST")).length;
    const result = f.shell("prepare_push 42 || exit 1");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Invalid CI readiness policy");
    expect(readFileSync(join(f.local, "prep.env"), "utf8")).toContain(`PREP_HEAD_SHA=${f.head}`);
    expect(calls().filter((args) => args.includes("POST"))).toHaveLength(before);
  });
});
