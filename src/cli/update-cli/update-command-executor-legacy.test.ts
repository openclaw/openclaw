import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { waitForDead, waitForFixtureFile } from "../../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const LEAF_CLEANUP_GUARD_MS = 5_000;

it.skipIf(process.platform === "win32").each([
  { managed: false, generation: false, lifetime: "live" },
  { managed: false, generation: false, lifetime: "exited" },
  { managed: true, generation: false, lifetime: "live" },
  { managed: true, generation: false, lifetime: "exited" },
  { managed: true, generation: false, lifetime: "replaced row" },
  { managed: true, generation: false, lifetime: "replaced database" },
  { managed: true, generation: false, lifetime: "altered grant" },
  { managed: true, generation: true, lifetime: "live" },
  { managed: true, generation: true, lifetime: "exited" },
] as const)(
  "native Doctor descendants retain the legacy parent's $lifetime lifetime (managed=$managed, generation=$generation)",
  async ({ managed, lifetime, generation }) => {
    const root = fs.realpathSync(dirs.make("legacy-package-parent-"));
    const targetRoot = generation ? path.join(root, "active") : root;
    if (generation) {
      fs.mkdirSync(targetRoot);
    }
    const control = path.join(root, "control");
    fs.mkdirSync(control);
    const file = (name: string) => path.join(root, name);
    const read = (name: string) => fs.readFileSync(file(name), "utf8");
    const leasePath = path.join(control, "managed-update-handoffs.sqlite");
    const contender = () =>
      createManagedHandoffLeaseStore({ databasePath: leasePath, serviceManagerEnv: process.env });
    const owner = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
    const importArgs = owner.pathname.endsWith(".ts")
      ? ["--import", path.resolve("scripts/tsx.mjs")]
      : [];
    const leaf = `
      import fs from 'node:fs';
      import {setTimeout} from 'node:timers/promises';
      import {text} from 'node:stream/consumers';
      const {grant,root}=JSON.parse(await text(process.stdin));
      fs.writeFileSync(root+'/leaf-pid',String(process.pid));
      const {withDelegatedUpdateCommandExecutor}=await import(${JSON.stringify(owner.href)});
      const parentPid=grant.originalParent.executor.pid;
      const observe=current=>fs.writeFileSync(root+'/observation.json',JSON.stringify({current,parentPid,...(${managed}?{helperPid:grant.originalParent.helper.pid}:{})}));
      if(${lifetime === "altered grant"}) {
        grant.originalParent.executor=grant.originalParent.helper;
        grant.parent.executor=grant.parent.helper;
      }
      try {
        await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
          fs.writeFileSync(root+'/ready','ready');
          while(!fs.existsSync(root+'/proceed')) await setTimeout(10);
          let current=false;
          try {fence.assertCurrent();current=true;fs.writeFileSync(root+'/effect','owned');}
          finally {observe(current);}
        });
      } catch(error) {
        if(${lifetime === "altered grant"}) {observe(false);fs.writeFileSync(root+'/ready','refused');}
        process.stderr.write(String(error));process.exitCode=1;
      }
    `;
    const continuation = `
      import fs from 'node:fs';
      import {withUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(owner.href)};
      import {createManagedHandoffLeaseStore} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.handoffLease).href)};
      import {registerSealedRuntime} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.sealedRegistry).href)};
      import {runUtf8CommandWithTimeout} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec).href)};
      const root=${JSON.stringify(root)},control=${JSON.stringify(control)};
      // The original parent may be killed; record the continuation's own exit.
      if(process.env.LEGACY_SECOND_PROBE!=='1')process.once('exit',code=>
        fs.writeFileSync(root+'/continuation-exit.json',JSON.stringify({code})));
      // Only scratch location is injected; live processes and lease authority remain real.
      registerSealedRuntime({json5:JSON,resolveSecureTempRoot:()=>control});
      const parent=createManagedHandoffLeaseStore().processIdentity(process.ppid);
      if(process.env.LEGACY_SECOND_PROBE==='1')await new Promise(resolve=>{
        process.once('message',()=>{process.disconnect();resolve();});
        process.send('ready');
      });
      try {
        await withUpdateCommandExecutor('original-update',async executor=>{
          const fence=await executor.enter(${JSON.stringify(targetRoot)});
          if(process.env.LEGACY_SECOND_PROBE==='1')return;
          const result=await withUpdateCommandExecutorChild(fence,${JSON.stringify(targetRoot)},(grant,beforeInput)=>
            runUtf8CommandWithTimeout([process.execPath,...${JSON.stringify(importArgs)},'--input-type=module','-e',${JSON.stringify(leaf)}],
              {input:JSON.stringify({grant,root}),beforeInput,timeoutMs:15000,killProcessTree:true,requireProcessTreeExtinction:true,onOutputChunk:chunk=>process.stdout.write(chunk)}));
          if(result.code!==0)throw new Error(result.stderr);
        },{legacyPackageParent:parent,...(${managed} ? {legacyPackageHandoff:{handoffId:'shipped-owner',root}} : {})});
      } catch(error) {
        if(process.env.LEGACY_SECOND_PROBE==='1')
          fs.writeFileSync(root+'/second-error.json',JSON.stringify({name:error.name,message:error.message}));
        process.stderr.write(String(error));process.exitCode=1;
      }
    `;
    const wrappedContinuation = `
      import {spawn} from 'node:child_process';
      import fs from 'node:fs';
      const probe=process.env.LEGACY_SECOND_PROBE==='1';
      if(!probe)fs.writeFileSync(${JSON.stringify(path.join(root, "wrapper-pid"))},String(process.pid));
      const child=spawn(process.execPath,[...${JSON.stringify(importArgs)},'--input-type=module','-e',${JSON.stringify(continuation)}],{stdio:probe?['ignore','inherit','inherit','ipc']:'inherit'});
      if(probe){
        child.once('message',()=>process.send('ready'));
        process.once('message',()=>{child.send('probe');process.disconnect();});
      }
      child.once('exit',code=>{process.exitCode=code??1;});
      child.once('error',error=>{process.stderr.write(String(error));process.exitCode=1;});
    `;
    const original = `
      import {spawn} from 'node:child_process';
      import fs from 'node:fs';
      import {DatabaseSync} from 'node:sqlite';
      import {createManagedHandoffLeaseStore} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.handoffLease).href)};
      if (${managed}) {
        fs.chmodSync(${JSON.stringify(control)},0o700);
        const db=new DatabaseSync(${JSON.stringify(path.join(control, "managed-update-handoffs.sqlite"))});
        db.exec('CREATE TABLE managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT');
        const {pid,startIdentity}=createManagedHandoffLeaseStore().processIdentity();
        const payload=JSON.stringify({version:1,pid,startIdentity});
        db.prepare('INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)').run(${JSON.stringify(root)},'shipped-owner',payload,7);
        db.close();
        fs.chmodSync(${JSON.stringify(path.join(control, "managed-update-handoffs.sqlite"))},0o600);
        fs.writeFileSync(${JSON.stringify(path.join(root, "original-row.json"))},JSON.stringify({install_root:${JSON.stringify(root)},owner:'shipped-owner',payload_json:payload,updated_at:7}));
      }
      const launch=probe=>spawn(process.execPath,[...${JSON.stringify(importArgs)},'--input-type=module','-e',${JSON.stringify(managed ? wrappedContinuation : continuation)}],{stdio:probe?['ignore','inherit','inherit','ipc']:'inherit',env:{...process.env,...(probe?{LEGACY_SECOND_PROBE:'1'}:{})}});
      if(${managed && lifetime === "live"}){
        const second=launch(true);
        second.once('message',()=>process.send('second-ready'));
        second.once('exit',(code,signal)=>process.send({event:'second-exit',code,signal},()=>process.disconnect()));
        process.once('message',()=>second.send('probe'));
      }
      const child=launch(false);
      child.once('exit',code=>{if(process.connected)process.disconnect();process.exitCode=code??1;});
      child.once('error',error=>{process.stderr.write(String(error));process.exitCode=1;});
    `;
    // The published parent has no modern executor. Keep its descendant alive
    // after parent death so the grandchild, not transport teardown, proves refusal.
    const child = spawn(process.execPath, [...importArgs, "--input-type=module", "-e", original], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const secondReady = createDeferred();
    const secondExited = createDeferred<unknown>();
    child.on("message", (message) => {
      if (message === "second-ready") {
        secondReady.resolve();
      } else {
        secondExited.resolve(message);
      }
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      expectDefined(stream, "Legacy fixture output").on("data", (chunk) => {
        output += String(chunk);
      });
    }
    const closed = once(child, "close");
    const exited = once(child, "exit");
    void exited.catch(() => {}); // Admission can fail before the exit join.
    let termination: ReturnType<typeof killProcessTree>;
    const killGroup = () => {
      if (child.pid && !termination) {
        termination = killProcessTree(child.pid, { detached: true });
      }
    };
    const signal = AbortSignal.timeout(20_000);
    const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
    try {
      await wait(
        Promise.all([
          waitForFixtureFile(file("ready"), closed),
          ...(managed && lifetime === "live" ? [secondReady.promise] : []),
        ]),
      );
      if (!child.pid) {
        throw new Error("Missing fixture parent PID");
      }
      if (generation) {
        expect(contender().acquire(targetRoot, "target-contender", { kind: "update" }).kind).toBe(
          "busy",
        );
      }
      if (managed && lifetime === "live") {
        child.send("probe");
        expect(await wait(Promise.race([secondExited.promise, closed])), output).toEqual({
          event: "second-exit",
          code: 1,
          signal: null,
        });
        // Process exit does not order delivery across stdout and stderr pipes.
        expect(JSON.parse(read("second-error.json"))).toEqual({
          name: "UpdateCommandRecoveryPendingError",
          message: "Legacy finalizer lifetime could not be acquired.",
        });
      }
      if (lifetime === "exited") {
        child.kill("SIGKILL");
        expect(await wait(exited), output).toEqual([null, "SIGKILL"]);
        expect(contender().acquire(root, "successor", { kind: "update" }).kind).toBe("busy");
      }
      if (lifetime === "replaced row") {
        const writer = new DatabaseSync(leasePath);
        writer
          .prepare("UPDATE managed_update_handoffs SET updated_at = 8 WHERE install_root = ?")
          .run(root);
        writer.close();
      }
      if (lifetime === "replaced database") {
        fs.copyFileSync(leasePath, `${leasePath}.replacement`);
        fs.renameSync(`${leasePath}.replacement`, leasePath);
      }
      fs.writeFileSync(file("proceed"), "go");
      await wait(closed);
      expect(
        fs.existsSync(file("continuation-exit.json")),
        `Legacy continuation did not exit: ${output}`,
      ).toBe(true);
      expect(JSON.parse(read("continuation-exit.json")), output).toEqual({
        code: lifetime === "live" ? 0 : 1,
      });
      if (lifetime === "live") {
        expect((await exited)[0], output).toBe(0);
      }
      expect(JSON.parse(read("observation.json"))).toEqual({
        current: lifetime === "live",
        parentPid: managed ? Number(read("wrapper-pid")) : child.pid,
        ...(managed ? { helperPid: child.pid } : {}),
      });
      expect(fs.existsSync(file("effect"))).toBe(lifetime === "live");
      {
        using database = new DatabaseSync(leasePath, { readOnly: true });
        if (managed) {
          const originalRow = JSON.parse(read("original-row.json"));
          expect(
            database
              .prepare("SELECT * FROM managed_update_handoffs WHERE install_root = ?")
              .get(root),
          ).toEqual({
            ...originalRow,
            updated_at: lifetime === "replaced row" ? 8 : 7,
          });
        }
        if (lifetime !== "replaced database") {
          expect(
            database.prepare("SELECT COUNT(*) AS count FROM managed_update_handoffs").get()?.count,
          ).toBe(managed ? 1 : 0);
        }
      }
      if (lifetime === "exited") {
        const store = contender();
        const acquired = store.acquire(root, "successor", { kind: "update" });
        expect(acquired.kind).toBe("acquired");
        if (acquired.kind === "acquired") {
          expect(store.release(acquired.lease)).toBe(true);
        }
      }
    } finally {
      // Failed assertions must also release the independently grouped native leaf.
      fs.writeFileSync(file("proceed"), "go");
      killGroup();
      await closed.finally(() => termination?.force());
      const leafPidFile = file("leaf-pid");
      if (fs.existsSync(leafPidFile)) {
        // Cleanup hang guard after the owner released/killed the group, not a readiness race.
        await waitForDead(
          Number(fs.readFileSync(leafPidFile, "utf8")),
          AbortSignal.timeout(LEAF_CLEANUP_GUARD_MS),
        );
      }
    }
  },
);
