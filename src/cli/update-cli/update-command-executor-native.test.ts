import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { decodeLaunchAgentPlistFixture } from "../../daemon/launchd-plist.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as processTree from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.executor,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["healthy", "spawner-settled", "root-replaced", "spawner-replaced"] as const)(
  "nested native child keeps original and immediate authority: %s",
  async (fault) => {
    const root = fs.realpathSync(dirs.make("native-nested-owner-"));
    const control = path.join(root, "control");
    fs.mkdirSync(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const proceed = path.join(root, "proceed");
    const effect = path.join(root, "effect");
    const ownerUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href;
    const leaf = `
      import fs from "node:fs";
      import {setTimeout} from "node:timers/promises";
      import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(ownerUrl)};
      const chunks=[];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      }
      const {grant,proceed,effect}=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
        process.stdout.write(JSON.stringify({ready:true,rootKey:grant.parent.key,spawnerKey:grant.spawner.key})+"\\n");
        while(!fs.existsSync(proceed)) await setTimeout(10);
        fence.assertCurrent();
        fs.writeFileSync(effect,"owned");
      });
    `;
    const intermediate = `
      import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(ownerUrl)};
      import {runUtf8CommandWithTimeout} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec).href)};
      const chunks=[];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      }
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async fence=>{
        const result=await withUpdateCommandExecutorChild(fence,input.grant.root,(grant,beforeInput)=>runUtf8CommandWithTimeout(
          [process.execPath,...${JSON.stringify(sourceImportArgs)},"--input-type=module","-e",${JSON.stringify(leaf)}],
          {input:JSON.stringify({...input,grant}),beforeInput,timeoutMs:15000,killProcessTree:true,
           requireProcessTreeExtinction:true,onOutputChunk:chunk=>{process.stdout.write(chunk);}}));
        if(result.code!==0)throw new Error(result.stderr);
        fence.assertCurrent();
      });
    `;
    const ready = createDeferred<{ rootKey: string; spawnerKey: string }>();
    let output = "";
    let admitted = false;
    const run = withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      const pending = withUpdateCommandExecutorChild(fence, root, (grant, beforeInput) =>
        runUtf8CommandWithTimeout(
          [process.execPath, ...sourceImportArgs, "--input-type=module", "-e", intermediate],
          {
            input: JSON.stringify({ grant, proceed, effect }),
            beforeInput,
            timeoutMs: 20_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            onOutputChunk: (chunk) => {
              output += chunk.toString();
              const line = output.split("\n").find((entry) => entry.startsWith('{"ready":true'));
              if (line) {
                ready.resolve(JSON.parse(line));
              }
            },
          },
        ),
      );
      try {
        const binding = await Promise.race([
          ready.promise,
          pending.then((result) => {
            throw new Error(result.stderr || "Child exited before admission");
          }),
        ]);
        admitted = true;
        expect(binding.rootKey).toBe(root);
        expect(binding.spawnerKey).not.toBe(root);
        const store = createManagedHandoffLeaseStore();
        expect(store.acquire(root, "replacement", { kind: "update" }).kind).toBe("busy");
        if (fault === "spawner-settled") {
          const spawner = store.read(binding.spawnerKey);
          if (spawner.kind !== "current") {
            throw new Error("Missing admitted spawner");
          }
          // Simulate a settled intermediate without killing either real child.
          // Its live descendant must still block release of the spawner row.
          const isDead = pidAlive.isPidDefinitelyDead;
          const isTreeAlive = processTree.isChildProcessTreeAlive;
          const deadSpy = vi
            .spyOn(pidAlive, "isPidDefinitelyDead")
            .mockImplementation((pid) => pid === spawner.lease.executor.pid || isDead(pid));
          const treeSpy = vi
            .spyOn(processTree, "isChildProcessTreeAlive")
            .mockImplementation(
              (child) => child.pid !== spawner.lease.executor.pid && isTreeAlive(child),
            );
          try {
            expect(
              store.release(spawner.lease),
              "live descendant retains intermediate custody",
            ).toBe(false);
          } finally {
            treeSpy.mockRestore();
            deadSpy.mockRestore();
          }
        }
        if (fault === "root-replaced" || fault === "spawner-replaced") {
          const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
          try {
            db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
              "revoked",
              fault === "root-replaced" ? root : binding.spawnerKey,
            );
          } finally {
            db.close();
          }
        }
      } finally {
        fs.writeFileSync(proceed, "go");
      }
      const result = await pending;
      expect(result.code, result.stderr).toBe(0);
    });
    if (fault === "healthy" || fault === "spawner-settled") {
      await run;
      expect(fs.readFileSync(effect, "utf8")).toBe("owned");
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
    } else {
      await expect(run).rejects.toThrow();
      expect(admitted, "fault must occur after nested admission").toBe(true);
      expect(fs.existsSync(effect)).toBe(false);
    }
  },
);

// Compose real root -> spawner -> registered receiver -> native/config writers.
// Only database LOCATION and scheduling barriers are fixtures, never authority.
it
  .skipIf(process.platform === "win32")
  .for([
    "healthy-upgrade",
    "original-replaced",
    "spawner-replaced",
    "spawner-killed",
    "config-precommit-replaced",
  ] as const)(
  "composed native/config effects retain original authority: %s",
  { timeout: 60_000 },
  async (fault, { onTestFailed }) => {
    const root = fs.realpathSync(dirs.make("native-composed-owner-"));
    const control = path.join(root, "control");
    fs.mkdirSync(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const target = fs.realpathSync(process.cwd());
    const config = path.join(root, "openclaw.json");
    const label = `ai.openclaw.proof.${randomUUID()}`;
    const plist = path.join(root, "Library", "LaunchAgents", `${label}.plist`);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: config,
    };
    const effect = path.join(root, "native-effect");
    const before = {
      gateway: {
        mode: "remote",
        port: 18789,
        auth: { mode: "token", token: "disposable-proof-token" },
      },
    };
    fs.writeFileSync(config, JSON.stringify(before));
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "previous-definition");
    const file = (name: string) => path.join(root, name);
    const receiver = `
    import fs from "node:fs";
    import {setTimeout} from "node:timers/promises";
    import * as json5 from ${JSON.stringify(import.meta.resolve("json5"))};
    import {registerSealedRuntime} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.sealedRuntime).href)};
    const root=${JSON.stringify(root)}, control=${JSON.stringify(control)}, fault=${JSON.stringify(fault)};
    registerSealedRuntime({json5,resolveSecureTempRoot:()=>control});
    const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)});
    const {execFileUtf8}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href)});
    const {writeLaunchAgentPlist}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.serviceFiles).href)});
    const {assertGatewayServiceUpdateCurrent}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.serviceAuthority).href)});
    const {createConfigIO}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.configIO).href)});
    const wait=async name=>{while(!fs.existsSync(root+"/"+name))await setTimeout(10);};
    const phase=(name,event)=>process.stderr.write(JSON.stringify({phase:name,event,elapsedMs:performance.now()})+"\\n");
    try { await runGatewayServiceUpdateCommand("run","install",async()=>{
      fs.writeFileSync(root+"/ready.tmp",String(process.pid));
      fs.renameSync(root+"/ready.tmp",root+"/ready");
      await wait("proceed");
      const results={};
      const attempt=async(name,fn)=>{
        phase(name,"start");
        try{await fn();results[name]="ok";}catch(e){results[name]=e.message;}
        phase(name,"end");
      };
      const io=createConfigIO({configPath:root+"/openclaw.json",env:{...process.env,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+"/openclaw.json"},observe:false,shellEnvFallback:"defer"});
      await attempt("config",()=>io.writeConfigFile({gateway:{mode:"local",port:18789,auth:{mode:"token",token:"disposable-proof-token"}}},{observe:false,beforeCommit:async()=>{
        if(fault==="config-precommit-replaced"){fs.writeFileSync(root+"/precommit","ready");await wait("publish");}
        assertGatewayServiceUpdateCurrent();
      }}));
      await attempt("native",async()=>{const r=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned")`)}]);if(r.code!==0)throw new Error(r.stderr);});
      await attempt("definition",()=>writeLaunchAgentPlist({env:{HOME:root,OPENCLAW_STATE_DIR:root,OPENCLAW_LAUNCHD_LABEL:${JSON.stringify(label)}},stdout:process.stdout,programArguments:[process.execPath,"next-definition"]}));
      fs.writeFileSync(root+"/done.tmp",JSON.stringify(results));
      fs.renameSync(root+"/done.tmp",root+"/done");
      await wait("release");
    });}catch(e){process.stderr.write(e.message);process.exitCode=1;}
  `;
    const spawner = `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href)};
    import {runUtf8CommandWithTimeout} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec).href)};
    const chunks=[];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
    }
    const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    try{await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async fence=>{
      const result=await withUpdateCommandExecutorChild(fence,input.grant.root,async(grant,beforeInput)=>{
        fs.writeFileSync(${JSON.stringify(file("binding"))},JSON.stringify(grant));
        if (${JSON.stringify(fault)} === "spawner-killed") {
          const stderr=fs.openSync(${JSON.stringify(file("receiver.stderr"))},"a");
          return new Promise((resolve,reject)=>{
            const child=spawn(process.execPath,[...${JSON.stringify(sourceImportArgs)},"--input-type=module","-e",${JSON.stringify(receiver)}],{stdio:["pipe","ignore",stderr],detached:true});
            fs.closeSync(stderr);
            child.once("error",reject);
            child.once("spawn",()=>{try{beforeInput(child.pid);child.stdin.end(JSON.stringify({action:"install",targetRoot:input.grant.root,executor:grant}));}catch(e){child.kill("SIGKILL");reject(e);}});
            child.once("exit",code=>resolve({code,stderr:"receiver exited"}));
          });
        }
        return runUtf8CommandWithTimeout([process.execPath,...${JSON.stringify(sourceImportArgs)},"--input-type=module","-e",${JSON.stringify(receiver)}],{
          input:JSON.stringify({action:"install",targetRoot:input.grant.root,executor:grant}),beforeInput,timeoutMs:30000,killProcessTree:true,requireProcessTreeExtinction:true,
          onOutputChunk:chunk=>process.stderr.write(chunk)});
      });
      if(result.code!==0)throw new Error(result.stderr);
    });}catch(e){process.stderr.write(e.message);process.exitCode=1;}
  `;
    let nativeOutput = "";
    onTestFailed(() => console.error(JSON.stringify({ fault, nativeOutput })));
    let leaf: number | undefined;
    const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      return withUpdateCommandExecutorChild<{
        code: number | null;
        stderr: string;
        cleanup?: string;
      }>(fence, target, (grant, beforeInput) => {
        if (fault === "spawner-killed") {
          // Bypass the transport's stronger whole-tree teardown only in this
          // fixture, so the genuine receiver can survive its dead spawner.
          return new Promise<{ code: number | null; stderr: string; cleanup: string }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                [...sourceImportArgs, "--input-type=module", "-e", spawner],
                { env: childEnv, stdio: ["pipe", "ignore", "pipe"], detached: true },
              );
              let stderr = "";
              child.stderr.on("data", (chunk) => {
                stderr += String(chunk);
                nativeOutput += String(chunk);
              });
              child.once("error", reject);
              child.once("spawn", () => {
                try {
                  beforeInput(child.pid!);
                  child.stdin.end(JSON.stringify({ grant }));
                } catch (error) {
                  child.kill("SIGKILL");
                  reject(
                    error instanceof Error
                      ? error
                      : new Error("Child binding failed", { cause: error }),
                  );
                }
              });
              child.once("exit", (code) => resolve({ code, stderr, cleanup: "normal" }));
            },
          );
        }
        return runUtf8CommandWithTimeout(
          [process.execPath, ...sourceImportArgs, "--input-type=module", "-e", spawner],
          {
            input: JSON.stringify({ grant }),
            env: childEnv,
            beforeInput,
            timeoutMs: 40_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            onOutputChunk: (chunk) => {
              nativeOutput += String(chunk);
            },
          },
        );
      });
    });
    // A killed intermediate may settle before the retained receiver: join below.
    const outcome = work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(fs.existsSync(file("ready"))).toBe(true), {
        timeout: 20_000,
        interval: 25,
      });
      leaf = Number(fs.readFileSync(file("ready"), "utf8"));
      const grant = JSON.parse(fs.readFileSync(file("binding"), "utf8"));
      expect(grant.originalParent.key).toBe(root);
      expect(grant.parent.key).toBe(target);
      expect(grant.spawner.key.startsWith(root + "/.openclaw-update-child-")).toBe(true);
      const revoke = (key: string) => {
        const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
        try {
          db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
            "revoked",
            key,
          );
        } finally {
          db.close();
        }
      };
      if (fault === "original-replaced") {
        revoke(root);
      }
      if (fault === "spawner-replaced") {
        revoke(grant.spawner.key);
      }
      if (fault === "spawner-killed") {
        process.kill(grant.spawner.executor.pid, "SIGKILL");
        await vi.waitFor(
          () => expect(pidAlive.isPidDefinitelyDead(grant.spawner.executor.pid)).toBe(true),
          { timeout: 5000 },
        );
        expect(createManagedHandoffLeaseStore().release(grant.spawner)).toBe(false);
      }
      fs.writeFileSync(file("proceed"), "go");
      if (fault === "config-precommit-replaced") {
        await vi.waitFor(() => expect(fs.existsSync(file("precommit"))).toBe(true), {
          timeout: 15_000,
        });
        revoke(root);
        fs.writeFileSync(file("publish"), "go");
      }
      await vi.waitFor(() => expect(fs.existsSync(file("done"))).toBe(true), {
        timeout: 20_000,
        interval: 25,
      });
      const results = JSON.parse(fs.readFileSync(file("done"), "utf8"));
      const store = createManagedHandoffLeaseStore();
      expect(store.acquire(root, "unrelated-updater", { kind: "update" }).kind).toBe("busy");
      expect(store.acquire(target, "unrelated-updater", { kind: "update" }).kind).toBe("busy");
      if (fault === "healthy-upgrade") {
        expect(results).toEqual({ config: "ok", native: "ok", definition: "ok" });
        expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({
          gateway: { ...before.gateway, mode: "local" },
        });
        expect(fs.readFileSync(effect, "utf8")).toBe("owned");
        const installed = JSON.parse(
          decodeLaunchAgentPlistFixture(fs.readFileSync(plist), "json").stdout,
        );
        expect(installed.Label).toBe(label);
        expect(installed.ProgramArguments).toEqual([process.execPath, "next-definition"]);
      } else {
        expect(Object.values(results)).toHaveLength(3);
        for (const result of Object.values(results)) {
          expect(result).toBe("The update process no longer has permission to continue.");
        }
        expect(fs.readFileSync(config, "utf8")).toBe(JSON.stringify(before));
        expect(fs.existsSync(effect)).toBe(false);
        expect(fs.readFileSync(plist, "utf8")).toBe("previous-definition");
      }
      fs.writeFileSync(file("release"), "go");
      const settled = await outcome;
      if (fault === "healthy-upgrade") {
        expect(settled).toMatchObject({ value: { code: 0 } });
        if (!("value" in settled)) {
          throw settled.error;
        }
        // A zero-exit root may still need graceful cleanup of its source-loader
        // helpers. Require joined extinction, not one platform's cleanup label.
        expect(["normal", "cooperative"]).toContain(settled.value.cleanup);
        expect(processTree.isChildProcessTreeAlive({ pid: grant.spawner.executor.pid })).toBe(
          false,
        );
        expect(pidAlive.isPidDefinitelyDead(leaf!)).toBe(true);
        expect(store.read(root)).toEqual({ kind: "absent" });
        expect(store.read(target)).toEqual({ kind: "absent" });
        // Recovery uses a fresh original owner after all native work joined.
        await withUpdateCommandExecutor(randomUUID(), async (executor) =>
          (await executor.enter(root)).assertCurrent(),
        );
      } else {
        expect("error" in settled || settled.value.code !== 0).toBe(true);
      }
    } finally {
      fs.writeFileSync(file("proceed"), "go");
      fs.writeFileSync(file("publish"), "go");
      fs.writeFileSync(file("release"), "go");
      await outcome;
      if (leaf && !pidAlive.isPidDefinitelyDead(leaf)) {
        process.kill(leaf, "SIGKILL");
        await vi.waitFor(() => expect(pidAlive.isPidDefinitelyDead(leaf!)).toBe(true), {
          timeout: 5000,
        });
      }
    }
  },
);
