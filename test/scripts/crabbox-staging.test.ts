import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasUnjoinedWork, runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  createFixtureDiagnostics,
  type FixtureDiagnostics,
} from "../helpers/fixture-diagnostics.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scriptUrl = (name: string) => new URL("../../scripts/" + name, import.meta.url).href;
const artifactBytes = Buffer.from([0, 255, 128, 10, 65]);
type Receipt = {
  version: number;
  id: string;
  ownerPid: number;
  state: string;
  users: string;
  kind: string;
  durable: boolean;
  hold?: string;
};
type Stage = { root: string; source: string; receipt: Receipt; destination?: string };
type Recovery = { id: string; recovered: boolean; reason: string };
type Inspection = {
  entries: { id: string; status: string; reason: string }[];
  incomplete: boolean;
  nextCursor?: string;
  elapsedMs: number;
};

async function withFixture(scenario: (context: ReturnType<typeof createFixture>) => Promise<void>) {
  const diagnostics = createFixtureDiagnostics("staging-recovery");
  const f = createFixture(diagnostics);
  let failure: Error | undefined;
  try {
    await scenario(f);
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("Recovery scenario failed", { cause: error });
  }
  try {
    await f.close(Boolean(failure));
  } catch (error) {
    diagnostics?.report("failure");
    throw failure
      ? new AggregateError([failure, error], "Recovery assertion and fixture cleanup failed", {
          cause: error,
        })
      : error;
  }
  if (failure) {
    throw failure;
  }
}

function createFixture(diagnostics?: FixtureDiagnostics) {
  const nodeExecutable = resolveTestNodeExecPath();
  const nodeArgs = resolveVitestNodeArgs();
  // openclaw-temp-dir: allow retain input ownership when a child cannot be joined
  const root = mkdtempSync(join(tmpdir(), "openclaw-crabbox-recovery-"));
  const source = join(root, "source"),
    staging = join(root, "staging"),
    bin = join(root, "bin"),
    home = join(root, "home");
  const cli = join(bin, "crabbox"),
    plan = join(root, "inventory.json"),
    calls = join(root, "native-calls.jsonl"),
    state = join(root, "state");
  for (const path of [source, staging, bin, home, join(state, "crabbox", "claims")]) {
    mkdirSync(path, { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    ...createNestedGitEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: state,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    PATH: bin + delimiter + process.env.PATH,
    OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
    OPENCLAW_CRABBOX_SYNC_TMPDIR: staging,
  };
  delete env.GIT_CONFIG_PARAMETERS;
  const gitAt = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const initialize = (directory: string) => {
    gitAt(directory, "init", "--quiet", "--initial-branch=main", "--template=");
    gitAt(directory, "remote", "add", "origin", "https://example.invalid/fixture.git");
  };
  initialize(source);
  writeFileSync(join(source, "source.txt"), "retained source\n");
  const commit = (cwd = source) => {
    gitAt(cwd, "add", "-A");
    gitAt(cwd, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  };
  commit();
  const inventory = (
    claims: { leaseId: string; repoRoot: string }[] = [],
    gate?: { ready: string; release: string },
  ) => writeFileSync(plan, JSON.stringify({ claims, gate }));
  inventory();
  writeFileSync(calls, "");
  writeFileSync(
    cli,
    `#!${nodeExecutable}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) !== JSON.stringify(['claims','list','--json'])) process.exit(91);
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, 'utf8'));
const finish = () => process.stdout.write(JSON.stringify({version:1,source:'local-claims',claims:plan.claims,problems:[]}));
if (plan.gate) {
  fs.writeFileSync(plan.gate.ready, 'ready');
  const timer = setInterval(() => { if (fs.existsSync(plan.gate.release)) { clearInterval(timer); finish(); } }, 10);
} else finish();
`,
  );
  chmodSync(cli, 0o700);
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<unknown>>();
  let unjoined = false;
  const command = (
    binary: string,
    args: string[],
    override: NodeJS.ProcessEnv = {},
    timeoutMs = 30_000,
    role = "command",
  ) => {
    const observation = diagnostics?.command(role);
    const controller = new AbortController();
    controllers.add(controller);
    const task = (async () => {
      let stdout = "",
        stderr = "",
        signal: NodeJS.Signals | null = null,
        tooLarge = false;
      let failure: unknown;
      try {
        const status = await runManagedCommand({
          bin: binary,
          args,
          cwd: repository,
          env: { ...env, ...override },
          stdio: ["ignore", "pipe", "pipe"],
          timeoutMs,
          requireProcessTreeExit: true,
          signal: controller.signal,
          onReady(child) {
            const capture = (chunk: Buffer, output: "stdout" | "stderr") => {
              observation?.output(output, chunk.byteLength);
              if (tooLarge) {
                return;
              }
              if (stdout.length + stderr.length + chunk.length > 1024 * 1024) {
                tooLarge = true;
                controller.abort(new Error("Recovery fixture output exceeded its limit"));
              } else if (output === "stdout") {
                stdout += chunk.toString();
              } else {
                stderr += chunk.toString();
              }
            };
            child.stdout!.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
            child.stderr!.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
            child.once("exit", (_code, received) => {
              signal = received;
            });
            observation?.ready(child);
          },
        });
        expect(tooLarge).toBe(false);
        return { status, signal, stdout, stderr };
      } catch (error) {
        failure = error;
        unjoined ||= hasUnjoinedWork(error);
        throw error;
      } finally {
        observation?.settled(failure);
        controllers.delete(controller);
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  };
  const program = (body: string, prelude = "", timeoutMs = 30_000, role = "program") =>
    command(
      nodeExecutable,
      [
        ...nodeArgs,
        "--import",
        resolve(repository, "scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import {join,resolve,basename} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const ctx = ${JSON.stringify({ root, repository: source, staging, cli, calls })};
${prelude}
syncBuiltinESMExports();
const {prepareCrabboxSourceCapsule} = await import(${JSON.stringify(scriptUrl("crabbox-source-capsule.mts"))});
const {createStaging,discoverStaging,recoverDiscoveredStaging,runStagingCommand} = await import(${JSON.stringify(scriptUrl("crabbox-staging.mts"))});
const {captureClaimNamespace} = await import(${JSON.stringify(scriptUrl("crabbox-staging-claims.mts"))});
const {preserveCrabboxArtifacts} = await import(${JSON.stringify(scriptUrl("crabbox-staging-artifacts.mts"))});
${body}`,
      ],
      {},
      timeoutMs,
      role,
    );
  const prepare = async (
    after = "",
    options: { paths?: string[]; before?: string; prelude?: string; localGitSeed?: boolean } = {},
  ) => {
    const names = options.paths ?? ["source.txt"];
    const selection = `const fs=require('node:fs');const paths=${JSON.stringify(names)}.filter(path=>fs.lstatSync(path,{throwIfNoEntry:false}));process.stdout.write(JSON.stringify({candidate:{files:paths.length},topFiles:paths.map(path=>({path})),localGitSeed:${options.localGitSeed ? "{source:'local'}" : "undefined"}}));`;
    const result = await program(
      `
${options.before ?? ""}
const cap = prepareCrabboxSourceCapsule({repoRoot:ctx.repository,syncRoot:ctx.staging,base:'HEAD',syncPlan:{command:process.execPath,args:['-e',${JSON.stringify(selection)}]}});
let artifacts;
${after}
const receipt = JSON.parse(fs.readFileSync(join(cap.staging.root,'staging.json'),'utf8'));
fs.writeSync(1,JSON.stringify({nodeArgs:process.execArgv.slice(0,process.execArgv.indexOf('-e')),root:cap.staging.root,source:cap.directory,receipt,destination:artifacts?.kind==='copied'?artifacts.destination.path:undefined}));
process.kill(process.pid,'SIGKILL');`,
      options.prelude,
      options.before ? 120_000 : 30_000,
      "prepare",
    );
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const { nodeArgs: producerNodeArgs, ...stage } = JSON.parse(result.stdout) as Stage & {
      nodeArgs: string[];
    };
    expect(producerNodeArgs, "fixture producer inherits the Node shutdown policy").toContain(
      "--no-concurrent-sparkplug",
    );
    return stage;
  };
  const wrapper = (args: string[], override: NodeJS.ProcessEnv = {}) =>
    command(
      nodeExecutable,
      [...nodeArgs, resolve(repository, "scripts/crabbox-wrapper.mjs"), "staging", ...args],
      override,
      undefined,
      "wrapper",
    );
  const recover = async (stage: Stage, args: string[] = [], override: NodeJS.ProcessEnv = {}) => {
    const result = await wrapper(["recover", stage.receipt.id, ...args], override);
    const report = JSON.parse(result.stdout) as Recovery;
    expect(result.status, result.stdout + result.stderr).toBe(report.recovered ? 0 : 1);
    return { ...result, report };
  };
  const automatic = async () => {
    const result = await program(
      `const discovery=discoverStaging(ctx.staging);const result=await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository});console.log(JSON.stringify({discovery,result}));`,
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { discovery: Inspection; result?: Recovery };
  };
  const waitFor = async (path: string) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path) && Date.now() < deadline) {
      await delay(10);
    }
    expect(existsSync(path), "fixture never reached its synchronization point: " + path).toBe(true);
  };
  return {
    root,
    source,
    staging,
    env,
    cli,
    calls,
    command,
    program,
    prepare,
    wrapper,
    recover,
    automatic,
    inventory,
    initialize,
    commit,
    git: (...args: string[]) => gitAt(source, ...args),
    gitAt,
    waitFor,
    stage: (value: string) => diagnostics?.stage(value),
    receipt: (stage: Stage) =>
      JSON.parse(readFileSync(join(stage.root, "staging.json"), "utf8")) as Receipt,
    async close(failed = false) {
      for (const controller of controllers) {
        controller.abort();
      }
      if (failed) {
        diagnostics?.report("failure");
      }
      await Promise.allSettled(pending);
      if (unjoined) {
        console.error("Recovery fixture retained after unverified child cleanup: " + root);
        throw Object.assign(new Error("Recovery fixture still has unjoined work"), {
          processTreeState: "indeterminate",
        });
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const admit = "cap.staging.admitted(captureClaimNamespace(cap.directory), ['cbx_fixture']);";
const diagnostics =
  "fs.mkdirSync(join(cap.directory,'.crabbox','runs','lease'),{recursive:true});fs.writeFileSync(join(cap.directory,'.crabbox','runs','lease','output.bin'),Buffer.from([0,255,128,10,65]));";
const preserve =
  "artifacts=preserveCrabboxArtifacts(cap.directory,ctx.repository);cap.staging.preserved(artifacts);";
function interruptedRemoval(remove: "none" | "file" | "payload") {
  return `const originalRm=fs.rmSync;let interrupted=false;
fs.rmSync=(path,options)=>{if(path===cap.staging.payload){interrupted=true;${remove === "file" ? "originalRm(join(cap.directory,'source.txt'));" : remove === "payload" ? "originalRm(path,options);" : ""}throw new Error('fixture interrupted removal');}return originalRm(path,options);};
syncBuiltinESMExports();try{cap.staging.dispose();}catch(error){if(!interrupted)throw error;}finally{fs.rmSync=originalRm;syncBuiltinESMExports();}
if(!interrupted)throw new Error('fixture failed to interrupt disposal');`;
}

function orderedDirectories(names: string[], position: "first" | "last") {
  return `const order=${JSON.stringify(names)};const originalDirectory=fs.opendirSync;
fs.opendirSync=(path,...args)=>{const directory=originalDirectory(path,...args);if(resolve(path)===resolve(ctx.staging)){const entries=[];for(let entry;(entry=directory.readSync());)entries.push(entry);const rank=(name)=>{const index=order.indexOf(name);return index<0?${position === "first" ? "order.length" : "-1"}:index;};entries.sort((left,right)=>rank(left.name)-rank(right.name)||left.name.localeCompare(right.name));let next=0;directory.readSync=()=>entries[next++]??null;}return directory;};`;
}

describe.skipIf(process.platform === "win32")(
  "staging recovery through the real producer and wrapper",
  () => {
    it(
      "recovers a real prepared capsule after its owner dies through the public wrapper",
      async () =>
        withFixture(async (f) => {
          const before = f.git("rev-parse", "HEAD");
          const stage = await f.prepare();
          expect(stage.receipt).toMatchObject({
            version: 2,
            state: "prepared",
            users: "none",
            durable: true,
          });
          const recovered = await f.recover(stage);
          expect(recovered.status, recovered.stderr + recovered.stdout).toBe(0);
          expect(recovered.report).toMatchObject({ id: stage.receipt.id, recovered: true });
          expect(readdirSync(f.staging)).toEqual([]);
          expect(readFileSync(join(f.source, "source.txt"), "utf8")).toBe("retained source\n");
          expect(f.git("rev-parse", "HEAD")).toBe(before);
          expect(f.git("status", "--porcelain")).toBe("");
        }),
      60_000,
    );

    it(
      "keeps preparation callbacks and additional Git workspaces held without disabling them",
      async () =>
        withFixture(async (f) => {
          const config = join(f.root, "home", ".gitconfig");
          const callback = join(f.root, "callback.sh");
          writeFileSync(callback, "#!/bin/sh\nprintf 'fixture-token\\000'\n", { mode: 0o700 });
          let first: Stage | undefined;
          for (const [section, key] of [
            ["core", "fsmonitor"],
            ["core", "hooksPath"],
            ['filter "fixture"', "process"],
            ["diff", "external"],
          ] as const) {
            f.stage(`${section}.${key}`);
            const bytes = `[${section}]\n${key} = ${JSON.stringify(callback)}\n`;
            writeFileSync(config, bytes);
            if (section.startsWith("filter ")) {
              f.stage("filter.process-unused");
              const unused = await f.prepare();
              expect(unused.receipt.hold).toBeUndefined();
              expect((await f.recover(unused)).report.recovered).toBe(true);
              writeFileSync(join(f.source, ".gitattributes"), "source.txt filter=fixture\n");
              f.stage("filter.process-used");
            }
            const stage = await f.prepare(
              admit +
                "cap.staging.settled();cap.staging.hold('artifacts');cap.staging.hold('claims');",
            );
            first ??= stage;
            expect(stage.receipt).toMatchObject({
              version: 2,
              state: "settled",
              users: "settled",
              hold: "writers",
            });
            expect((await f.recover(stage)).report).toMatchObject({
              recovered: false,
              reason: expect.stringContaining("settlement is unverified"),
            });
            expect(readFileSync(config, "utf8")).toBe(bytes);
            if (section.startsWith("filter ")) {
              f.stage("filter.process-deleted-source");
              const sourceFile = join(f.source, "source.txt");
              const retained = readFileSync(sourceFile);
              rmSync(sourceFile);
              const deleted = await f.prepare();
              expect(deleted.receipt.hold).toBe("writers");
              expect(
                JSON.parse(readFileSync(join(deleted.root, "manifest.json"), "utf8")).source
                  .deleted,
              ).toContain("source.txt");
              expect((await f.recover(deleted)).report.recovered).toBe(false);
              writeFileSync(sourceFile, retained);
            }
            rmSync(join(f.source, ".gitattributes"), { force: true });
          }
          for (const driver of ["unset", "unspecified"]) {
            f.stage(`filter-${driver}`);
            writeFileSync(config, `[filter "${driver}"]\nprocess = ${JSON.stringify(callback)}\n`);
            writeFileSync(join(f.source, ".gitattributes"), `source.txt filter=${driver}\n`);
            expect(f.git("check-attr", "filter", "--", "source.txt")).toBe(
              `source.txt: filter: ${driver}`,
            );
            const ambiguous = await f.prepare();
            expect(ambiguous.receipt.hold).toBe("writers");
            expect((await f.recover(ambiguous)).report.recovered).toBe(false);
          }
          rmSync(join(f.source, ".gitattributes"));
          f.stage("fsmonitor-disabled");
          writeFileSync(config, "[core]\nfsmonitor = false\n");
          expect((await f.recover(first!)).report.recovered).toBe(false);
          const disabled = await f.prepare();
          expect(disabled.receipt.hold).toBeUndefined();
          expect((await f.recover(disabled)).report.recovered).toBe(true);
          f.stage("additional-git-workspace");
          const additional = await f.prepare("", { localGitSeed: true });
          expect(additional.receipt.hold).toBe("writers");
          expect((await f.recover(additional)).report.recovered).toBe(false);
          f.stage("old-receipt");
          const earlier = await f.prepare();
          writeFileSync(
            join(earlier.root, "staging.json"),
            JSON.stringify({ ...f.receipt(earlier), version: 1 }),
          );
          expect((await f.recover(earlier)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("invalid metadata"),
          });
        }),
      120_000,
    );

    it(
      "holds admitted writers and requires explicit retry for settled diagnostics",
      async () =>
        withFixture(async (f) => {
          const admitted = await f.prepare(admit + diagnostics);
          const held = await f.recover(admitted);
          expect(held.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("settlement was not recorded"),
          });
          expect(readFileSync(join(admitted.source, ".crabbox/runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
          const settled = await f.prepare(admit + diagnostics + "cap.staging.settled();");
          const automatic = await f.automatic();
          expect(
            automatic.discovery.entries.find((entry) => entry.id === settled.receipt.id)?.status,
          ).toBe("protected");
          expect(automatic.result).toBeUndefined();
          expect(existsSync(join(f.source, ".crabbox/wrapper-artifacts"))).toBe(false);
          const recovered = await f.recover(settled);
          expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          const [destination] = readdirSync(join(f.source, ".crabbox/wrapper-artifacts"));
          expect(
            readFileSync(
              join(f.source, ".crabbox/wrapper-artifacts", destination!, "runs/lease/output.bin"),
            ),
          ).toEqual(artifactBytes);
          expect(existsSync(admitted.root)).toBe(true);
        }),
      90_000,
    );

    it.each(["automatic", "removing"] as const)(
      "holds corrupted preserved artifacts during %s recovery",
      async (mode) =>
        withFixture(async (f) => {
          const stage = await f.prepare(
            admit +
              diagnostics +
              "cap.staging.settled();" +
              preserve +
              (mode === "removing" ? interruptedRemoval("none") : ""),
          );
          const saved = join(stage.destination!, "runs/lease/output.bin");
          writeFileSync(saved, "changed saved diagnostics");
          const result =
            mode === "automatic" ? (await f.automatic()).result : (await f.recover(stage)).report;
          expect(result).toMatchObject({
            recovered: false,
            reason: expect.stringMatching(/artifact/i),
          });
          expect(existsSync(stage.root)).toBe(true);
          expect(readFileSync(saved, "utf8")).toBe("changed saved diagnostics");
          expect(readFileSync(join(stage.source, ".crabbox/runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
          expect(readdirSync(join(f.source, ".crabbox/wrapper-artifacts"))).toHaveLength(1);
        }),
      90_000,
    );

    it(
      "retries preservation after artifact evidence was written but its receipt update failed",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(
            admit +
              diagnostics +
              "cap.staging.settled();" +
              `
artifacts=preserveCrabboxArtifacts(cap.directory,ctx.repository);
const originalRename=fs.renameSync;let interrupted=false;
fs.renameSync=(from,to)=>{if(to===join(cap.staging.root,'staging.json')){interrupted=true;throw new Error('fixture interrupted artifact publication');}return originalRename(from,to);};
syncBuiltinESMExports();try{cap.staging.preserved(artifacts);}catch(error){if(!interrupted)throw error;}finally{fs.renameSync=originalRename;syncBuiltinESMExports();}
if(!interrupted)throw new Error('fixture did not interrupt artifact publication');`,
          );
          expect(stage.receipt.state).toBe("settled");
          expect(
            readdirSync(stage.root).filter((name) => /^artifacts-[a-f0-9]{64}\.json$/u.test(name)),
          ).toHaveLength(1);
          expect((await f.recover(stage)).report.recovered).toBe(true);
          expect(existsSync(stage.root)).toBe(false);
          expect(readFileSync(join(stage.destination!, "runs/lease/output.bin"))).toEqual(
            artifactBytes,
          );
        }),
      90_000,
    );

    it(
      "holds claim-bound stages and changed namespaces without rewriting claims",
      async () =>
        withFixture(async (f) => {
          const bound = await f.prepare();
          f.inventory([{ leaseId: "cbx_bound_fixture", repoRoot: bound.source }]);
          const held = await f.recover(bound);
          expect(held.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("cbx_bound_fixture"),
          });
          expect(f.receipt(bound).hold).toBe("claims");
          expect(existsSync(bound.root)).toBe(true);
          f.inventory();
          expect((await f.automatic()).result).toBeUndefined();
          expect((await f.recover(bound)).report.recovered).toBe(true);
          const changed = await f.prepare();
          const calls = readFileSync(f.calls, "utf8");
          const wrongNamespace = await f.recover(changed, [], {
            XDG_STATE_HOME: join(f.root, "other-state"),
          });
          expect(wrongNamespace.report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("location changed"),
          });
          expect(readFileSync(f.calls, "utf8")).toBe(calls);
          expect((await f.recover(changed)).report.recovered).toBe(true);
          for (const line of readFileSync(f.calls, "utf8").trim().split("\n")) {
            expect(JSON.parse(line)).toEqual(["claims", "list", "--json"]);
          }
        }),
      120_000,
    );

    it(
      "allows only expected omissions after interrupted removal",
      async () =>
        withFixture(async (f) => {
          const premature = await f.prepare();
          rmSync(join(premature.source, "source.txt"));
          expect((await f.recover(premature)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("missing before disposal"),
          });
          for (const removed of ["file", "payload"] as const) {
            const partial = await f.prepare(interruptedRemoval(removed));
            expect(partial.receipt.state).toBe("removing");
            const recovered = await f.recover(partial);
            expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          }
          const added = await f.prepare(interruptedRemoval("file"));
          writeFileSync(join(added.source, "unexpected.txt"), "new bytes must survive\n");
          expect((await f.recover(added)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("gained an entry"),
          });
          expect(readFileSync(join(added.source, "unexpected.txt"), "utf8")).toBe(
            "new bytes must survive\n",
          );
        }),
      120_000,
    );

    it(
      "requires an independent retained ref with exact dirty bytes, modes, symlinks, and deletions",
      async () =>
        withFixture(async (f) => {
          writeFileSync(join(f.source, "exec.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
          symlinkSync("source.txt", join(f.source, "link"));
          writeFileSync(join(f.source, "removed.txt"), "old source\n");
          f.commit();
          writeFileSync(join(f.source, "source.txt"), "unique dirty source\n");
          rmSync(join(f.source, "removed.txt"));
          const stage = await f.prepare("", {
            paths: ["source.txt", "exec.sh", "link", "removed.txt"],
          });
          expect(lstatSync(join(stage.source, "exec.sh")).mode & 0o100).toBe(0o100);
          expect(readlinkSync(join(stage.source, "link"))).toBe("source.txt");
          expect((await f.recover(stage)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("source.txt"),
          });
          const witness = join(f.root, "retained-source");
          mkdirSync(witness);
          f.initialize(witness);
          writeFileSync(join(witness, "source.txt"), "unique dirty source\n");
          writeFileSync(join(witness, "exec.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
          symlinkSync("wrong-target", join(witness, "link"));
          writeFileSync(join(witness, "unselected.txt"), "additional retained paths are allowed\n");
          f.commit(witness);
          const selected = ["--witness-repo", witness, "--witness-ref", "refs/heads/main"];
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("exec.sh"),
          });
          chmodSync(join(witness, "exec.sh"), 0o755);
          f.commit(witness);
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("link"),
          });
          rmSync(join(witness, "link"));
          symlinkSync("source.txt", join(witness, "link"));
          writeFileSync(join(witness, "removed.txt"), "deletion must also be retained\n");
          f.commit(witness);
          expect((await f.recover(stage, selected)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("deletion"),
          });
          rmSync(join(witness, "removed.txt"));
          f.commit(witness);
          rmSync(f.source, { recursive: true });
          const recovered = await f.recover(stage, selected);
          expect(recovered.report.recovered, recovered.stdout + recovered.stderr).toBe(true);
          expect(readFileSync(join(witness, "source.txt"), "utf8")).toBe("unique dirty source\n");
          expect(existsSync(f.source)).toBe(false);
        }),
      120_000,
    );

    it(
      "protects live or uncertain owner PIDs, substituted paths, and retained recovery locks",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare();
          const receiptFile = join(stage.root, "staging.json"),
            original = readFileSync(receiptFile, "utf8");
          writeFileSync(
            receiptFile,
            JSON.stringify({ ...JSON.parse(original), ownerPid: process.pid }),
          );
          expect((await f.recover(stage)).report.reason).toContain("live or cannot be checked");
          writeFileSync(receiptFile, original);
          const uncertain = await f.program(
            `process.exitCode=await runStagingCommand(['recover',${JSON.stringify(stage.receipt.id)}],ctx.staging,{binary:ctx.cli,cwd:ctx.repository});`,
            `const originalKill=process.kill;process.kill=(pid,signal)=>{if(pid===${stage.receipt.ownerPid}&&signal===0)throw Object.assign(new Error('fixture denied owner lookup'),{code:'EPERM'});return originalKill(pid,signal);};`,
          );
          expect(JSON.parse(uncertain.stdout)).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("cannot be checked"),
          });
          const lock = join(stage.root, "recovery.lock");
          mkdirSync(lock);
          writeFileSync(
            join(lock, "owner.json"),
            JSON.stringify({ pid: stage.receipt.ownerPid, generation: "interrupted-fixture" }),
          );
          expect((await f.recover(stage)).report.reason).toContain("interrupted recovery");
          expect(existsSync(lock)).toBe(true);
          const replaced = await f.prepare(),
            saved = replaced.root + "-saved";
          const bytes = readFileSync(join(replaced.root, "staging.json"));
          renameSync(replaced.root, saved);
          mkdirSync(replaced.root);
          writeFileSync(join(replaced.root, "staging.json"), bytes);
          expect((await f.recover(replaced)).report).toMatchObject({ recovered: false });
          expect(readFileSync(join(saved, "payload/source/source.txt"), "utf8")).toBe(
            "retained source\n",
          );
        }),
      120_000,
    );

    it(
      "allows only one concurrent recovery owner and detects changed receipts during verification",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(),
            gate = { ready: join(f.root, "claims-ready"), release: join(f.root, "claims-release") };
          f.inventory([], gate);
          const first = f.recover(stage);
          await f.waitFor(gate.ready);
          expect((await f.recover(stage)).report.reason).toContain("interrupted recovery");
          writeFileSync(gate.release, "release");
          expect((await first).report.recovered).toBe(true);
          f.inventory();
          const changed = await f.prepare();
          rmSync(gate.ready);
          rmSync(gate.release);
          f.inventory([], gate);
          const recovering = f.recover(changed);
          await f.waitFor(gate.ready);
          writeFileSync(
            join(changed.root, "staging.json"),
            JSON.stringify({ ...f.receipt(changed), hold: "writers" }),
          );
          writeFileSync(gate.release, "release");
          expect((await recovering).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("ownership changed"),
          });
          expect(existsSync(changed.root)).toBe(true);
        }),
      120_000,
    );

    it(
      "protects FIFO receipts without reading or replacing them",
      async () =>
        withFixture(async (f) => {
          f.stage("prepare-fifo");
          const fifo = await f.prepare(),
            receipt = join(fifo.root, "staging.json");
          rmSync(receipt);
          f.stage("mkfifo");
          const made = await f.command("mkfifo", [receipt]);
          expect(made.status, made.stderr).toBe(0);
          f.stage("recover-fifo");
          expect((await f.recover(fifo)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("invalid metadata"),
          });
          expect(lstatSync(receipt).isFIFO()).toBe(true);
        }),
      90_000,
    );

    it(
      "keeps real full-worktree registrations and hook outputs protected",
      async () =>
        withFixture(async (f) => {
          const hook = join(f.source, ".git/hooks/post-checkout");
          mkdirSync(join(f.source, ".git/hooks"), { recursive: true });
          writeFileSync(hook, "#!/bin/sh\nprintf 'hook-owned bytes' > hook-output.txt\n", {
            mode: 0o700,
          });
          const created = await f.program(
            `const owner=createStaging(ctx.staging,ctx.repository,'worktree');const source=join(owner.payload,'source');const added=cp.spawnSync('git',['-C',ctx.repository,'worktree','add','--detach',source,'HEAD'],{stdio:'pipe'});if(added.status!==0)throw new Error(added.stderr.toString());owner.admitted(captureClaimNamespace(source));owner.settled();owner.preserved(preserveCrabboxArtifacts(source,ctx.repository));fs.writeSync(1,JSON.stringify({root:owner.root,source,receipt:JSON.parse(fs.readFileSync(join(owner.root,'staging.json'),'utf8'))}));process.kill(process.pid,'SIGKILL');`,
          );
          expect(created.signal, created.stderr).toBe("SIGKILL");
          const stage = JSON.parse(created.stdout) as Stage;
          const registered = f.git("worktree", "list", "--porcelain");
          expect(registered).toContain(stage.source);
          expect((await f.recover(stage)).report).toMatchObject({
            recovered: false,
            reason: expect.stringContaining("hooks or filters"),
          });
          expect(f.git("worktree", "list", "--porcelain")).toBe(registered);
          expect(readFileSync(join(stage.source, "hook-output.txt"), "utf8")).toBe(
            "hook-owned bytes",
          );
        }),
      90_000,
    );

    it(
      "recovers an independent candidate without replacing an unknown discovery cursor",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare(),
            cursor = join(f.staging, "openclaw-crabbox-sync-discovery");
          mkdirSync(cursor);
          writeFileSync(join(cursor, "operator-note"), "unknown cursor bytes\n");
          expect((await f.automatic()).result).toMatchObject({
            id: stage.receipt.id,
            recovered: true,
          });
          expect(readdirSync(cursor)).toEqual(["operator-note"]);
          expect(readFileSync(join(cursor, "operator-note"), "utf8")).toBe(
            "unknown cursor bytes\n",
          );
        }),
      60_000,
    );

    it(
      "advances past a dirty candidate so the following clean candidate can recover",
      async () =>
        withFixture(async (f) => {
          writeFileSync(join(f.source, "source.txt"), "unretained dirty source\n");
          const dirty = await f.prepare();
          writeFileSync(join(f.source, "source.txt"), "retained source\n");
          const clean = await f.prepare();
          const result = await f.program(
            `const results=[];for(let i=0;i<2;i++){const discovery=discoverStaging(ctx.staging);results.push(await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository}));}console.log(JSON.stringify(results));`,
            orderedDirectories([basename(dirty.root), basename(clean.root)], "first"),
          );
          expect(result.status, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout)).toMatchObject([
            { id: dirty.receipt.id, recovered: false },
            { id: clean.receipt.id, recovered: true },
          ]);
          expect(readFileSync(join(dirty.source, "source.txt"), "utf8")).toBe(
            "unretained dirty source\n",
          );
          expect(existsSync(clean.root)).toBe(false);
        }),
      90_000,
    );

    it(
      "reaches a candidate beyond 64 protected entries over bounded metadata-only discovery passes",
      async () =>
        withFixture(async (f) => {
          const stage = await f.prepare("", {
            before: "for(let i=0;i<64;i++)createStaging(ctx.staging,ctx.repository,'worktree');",
          });
          const measurement = await f.program(
            `
const passes=[];
for(let pass=0;pass<128&&fs.existsSync(${JSON.stringify(stage.root)});pass++){
  counters={headers:0,bytes:0,payload:0,commands:0,hashes:0,osReads:0,osBytes:0,osCommands:0,osHashes:0,osHashBytes:0};phase='discover';
  const discovery=discoverStaging(ctx.staging);phase='recover';
  const metrics={...counters,entries:discovery.entries.length,elapsedMs:discovery.elapsedMs,statuses:discovery.entries.map(entry=>entry.status)};
  const result=await recoverDiscoveredStaging(ctx.staging,discovery,{binary:ctx.cli,cwd:ctx.repository});
  phase='idle';passes.push({...metrics,recovered:result?.recovered===true});
}
console.log(JSON.stringify({passes,remaining:fs.existsSync(${JSON.stringify(stage.root)})}));`,
            `
let phase='idle';let counters;let observedBoot='',observedNamespace='';const descriptors=new Map();
const originalOpen=fs.openSync,originalRead=fs.readSync,originalClose=fs.closeSync;
fs.openSync=(path,...args)=>{const fd=originalOpen(path,...args);descriptors.set(fd,String(path));if(phase==='discover'){if(basename(String(path))==='staging.json')counters.headers++;if(String(path).includes('/payload'))counters.payload++;}return fd;};
fs.readSync=(fd,...args)=>{const count=originalRead(fd,...args);if(phase==='discover'&&descriptors.has(fd)){if(descriptors.get(fd)==='/proc/sys/kernel/random/boot_id'){counters.osReads++;counters.osBytes+=count;if(Buffer.isBuffer(args[0])&&args[0].length<=128)observedBoot=args[0].subarray(0,count).toString('utf8').trim();}else counters.bytes+=count;}return count;};
fs.closeSync=(fd)=>{descriptors.delete(fd);return originalClose(fd);};
const originalReadlink=fs.readlinkSync;fs.readlinkSync=(path,...args)=>{const value=originalReadlink(path,...args);if(phase==='discover'&&path==='/proc/self/ns/pid'){counters.osReads++;counters.osBytes+=Buffer.byteLength(String(value));if(Buffer.byteLength(String(value))<=128)observedNamespace=String(value);}return value;};
for(const name of ['lstatSync','statSync','readFileSync','readdirSync','readlinkSync']){const original=fs[name];fs[name]=(path,...args)=>{if(phase==='discover'&&String(path).includes('/payload'))counters.payload++;return original(path,...args);};}
${orderedDirectories([basename(stage.root)], "last")}
for(const name of ['spawn','spawnSync','execFileSync']){const original=cp[name];cp[name]=(...args)=>{const options=args[2];const bootProbe=phase==='discover'&&process.platform==='darwin'&&name==='spawnSync'&&args[0]==='/usr/sbin/sysctl'&&JSON.stringify(args[1])===JSON.stringify(['-n','kern.bootsessionuuid'])&&options?.encoding==='utf8'&&options.env&&Object.keys(options.env).length===0&&options.timeout>0&&options.timeout<=1000&&options.maxBuffer>0&&options.maxBuffer<=1024;if(phase==='discover'){if(bootProbe)counters.osCommands++;else counters.commands++;}const result=original(...args);if(bootProbe&&typeof result.stdout==='string'){observedBoot=result.stdout.trim();counters.osBytes+=Buffer.byteLength(result.stdout);}return result;};}
const originalHash=crypto.createHash;crypto.createHash=(algorithm,...args)=>{const hash=originalHash(algorithm,...args);if(phase==='discover'){const metrics=counters;metrics.hashes++;const update=hash.update.bind(hash),digest=hash.digest.bind(hash);let updates=0,identity=false,size=0,finished=false;hash.update=(data,...options)=>{updates++;size=typeof data==='string'?Buffer.byteLength(data):0;identity=updates===1&&algorithm==='sha256'&&typeof data==='string'&&size<=256&&observedBoot.length===36&&(process.platform==='darwin'||observedNamespace.startsWith('pid:['))&&data===process.platform+':'+observedBoot.toLowerCase()+':'+observedNamespace;return update(data,...options);};hash.digest=(...options)=>{if(!finished&&identity){metrics.hashes--;metrics.osHashes++;metrics.osHashBytes+=size;}finished=true;return digest(...options);};}return hash;};`,
            120_000,
          );
          expect(measurement.status, measurement.stderr).toBe(0);
          const report = JSON.parse(measurement.stdout) as {
            passes: {
              headers: number;
              bytes: number;
              payload: number;
              commands: number;
              hashes: number;
              osReads: number;
              osBytes: number;
              osCommands: number;
              osHashes: number;
              osHashBytes: number;
              entries: number;
              elapsedMs: number;
              statuses: string[];
              recovered: boolean;
            }[];
            remaining: boolean;
          };
          expect(report.remaining).toBe(false);
          expect(report.passes.length).toBeGreaterThan(1);
          expect(report.passes[0]!.statuses.every((status) => status === "protected")).toBe(true);
          expect(report.passes.filter((pass) => pass.recovered)).toHaveLength(1);
          // Classify only the observed boot/PID-namespace digest as bounded OS
          // metadata. No discovery pass is run before measurement or prewarmed.
          expect(report.passes.reduce((sum, pass) => sum + pass.osHashes, 0)).toBe(1);
          expect(report.passes.reduce((sum, pass) => sum + pass.osCommands, 0)).toBe(
            process.platform === "darwin" ? 1 : 0,
          );
          for (const pass of report.passes) {
            expect(pass.headers).toBeLessThanOrEqual(64);
            expect(pass.entries).toBeLessThanOrEqual(64);
            expect(pass).toMatchObject({ payload: 0, commands: 0, hashes: 0 });
            expect(pass.bytes).toBeLessThanOrEqual(65 * 32 * 1024);
            expect(pass.osReads).toBeLessThanOrEqual(2);
            expect(pass.osBytes).toBeLessThanOrEqual(256);
            expect(pass.osHashBytes).toBeLessThanOrEqual(256);
          }
          expect(readFileSync(f.calls, "utf8").trim().split("\n")).toHaveLength(2);
          console.info(
            "Staging discovery metadata measurements: " +
              JSON.stringify(
                report.passes.map(
                  ({
                    headers,
                    bytes,
                    elapsedMs,
                    osReads,
                    osBytes,
                    osCommands,
                    osHashes,
                    osHashBytes,
                  }) => ({
                    headers,
                    bytes,
                    elapsedMs,
                    osReads,
                    osBytes,
                    osCommands,
                    osHashes,
                    osHashBytes,
                  }),
                ),
              ),
          );
        }),
      180_000,
    );
  },
);
