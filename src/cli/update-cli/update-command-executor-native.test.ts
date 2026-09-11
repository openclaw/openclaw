import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as processTree from "../../process/child-process-tree.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import * as pidAlive from "../../shared/pid-alive.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

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
    const ownerUrl = new URL("./update-command-executor.ts", import.meta.url).href;
    const loader = path.resolve("scripts/tsx.mjs");
    const leaf = `
      import fs from "node:fs";
      import {setTimeout} from "node:timers/promises";
      import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(ownerUrl)};
      const {grant,proceed,effect}=JSON.parse(fs.readFileSync(0,"utf8"));
      await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async fence=>{
        process.stdout.write(JSON.stringify({ready:true,rootKey:grant.parent.key,spawnerKey:grant.spawner.key})+"\\n");
        while(!fs.existsSync(proceed)) await setTimeout(10);
        fence.assertCurrent();
        fs.writeFileSync(effect,"owned");
      });
    `;
    const intermediate = `
      import fs from "node:fs";
      import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(ownerUrl)};
      import {runUtf8CommandWithTimeout} from ${JSON.stringify(new URL("../../process/exec.ts", import.meta.url).href)};
      const input=JSON.parse(fs.readFileSync(0,"utf8"));
      await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async fence=>{
        const result=await withUpdateCommandExecutorChild(fence,input.grant.root,(grant,beforeInput)=>runUtf8CommandWithTimeout(
          [process.execPath,"--import",${JSON.stringify(loader)},"--input-type=module","-e",${JSON.stringify(leaf)}],
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
          [process.execPath, "--import", loader, "--input-type=module", "-e", intermediate],
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
  .each([
    "healthy-upgrade",
    "original-replaced",
    "spawner-replaced",
    "spawner-killed",
    "config-precommit-replaced",
  ] as const)(
  "composed native/config effects retain original authority: %s",
  async (fault) => {
    const root = fs.realpathSync(dirs.make("native-composed-owner-"));
    const control = path.join(root, "control");
    fs.mkdirSync(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const target = fs.realpathSync(process.cwd());
    const config = path.join(root, "openclaw.json");
    const plist = path.join(root, "gateway.plist");
    const effect = path.join(root, "native-effect");
    const before = {
      gateway: {
        mode: "remote",
        port: 18789,
        auth: { mode: "token", token: "disposable-proof-token" },
      },
    };
    fs.writeFileSync(config, JSON.stringify(before));
    fs.writeFileSync(plist, "previous-definition");
    const file = (name: string) => path.join(root, name);
    const receiver = `
    import fs from "node:fs";
    import {setTimeout} from "node:timers/promises";
    import {runGatewayServiceUpdateCommand} from ${JSON.stringify(new URL("../daemon-cli/update-executor.ts", import.meta.url).href)};
    import {execFileUtf8} from ${JSON.stringify(new URL("../../daemon/exec-file.ts", import.meta.url).href)};
    import {publishLaunchAgentPlist} from ${JSON.stringify(new URL("../../daemon/launchd-service-files.ts", import.meta.url).href)};
    import {assertGatewayServiceUpdateCurrent} from ${JSON.stringify(new URL("../../daemon/service-update-authority.ts", import.meta.url).href)};
    import {createConfigIO} from ${JSON.stringify(new URL("../../config/io.factory.ts", import.meta.url).href)};
    const root=${JSON.stringify(root)}, fault=${JSON.stringify(fault)};
    const wait=async name=>{while(!fs.existsSync(root+"/"+name))await setTimeout(10);};
    try { await runGatewayServiceUpdateCommand("run","install",async()=>{
      fs.writeFileSync(root+"/ready",String(process.pid));
      await wait("proceed");
      const results={};
      const attempt=async(name,fn)=>{try{await fn();results[name]="ok";}catch(e){results[name]=e.message;}};
      const io=createConfigIO({configPath:root+"/openclaw.json",env:{...process.env,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:root+"/openclaw.json"},observe:false,shellEnvFallback:"defer"});
      await attempt("config",()=>io.writeConfigFile({gateway:{mode:"local",port:18789,auth:{mode:"token",token:"disposable-proof-token"}}},{observe:false,beforeCommit:async()=>{
        if(fault==="config-precommit-replaced"){fs.writeFileSync(root+"/precommit","ready");await wait("publish");}
        assertGatewayServiceUpdateCurrent();
      }}));
      await attempt("native",async()=>{const r=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned")`)}]);if(r.code!==0)throw new Error(r.stderr);});
      await attempt("definition",()=>publishLaunchAgentPlist({label:${JSON.stringify("ai.openclaw.proof." + randomUUID())},plistPath:root+"/gateway.plist",contents:"next-definition"}));
      fs.writeFileSync(root+"/done",JSON.stringify(results));
      await wait("release");
    });}catch(e){process.stderr.write(e.message);process.exitCode=1;}
  `;
    const spawner = `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild} from ${JSON.stringify(new URL("./update-command-executor.ts", import.meta.url).href)};
    import {runUtf8CommandWithTimeout} from ${JSON.stringify(new URL("../../process/exec.ts", import.meta.url).href)};
    const input=JSON.parse(fs.readFileSync(0,"utf8"));
    try{await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async fence=>{
      const result=await withUpdateCommandExecutorChild(fence,input.grant.root,async(grant,beforeInput)=>{
        fs.writeFileSync(${JSON.stringify(file("binding"))},JSON.stringify(grant));
        if (${JSON.stringify(fault)} === "spawner-killed") {
          const stderr=fs.openSync(${JSON.stringify(file("receiver.stderr"))},"a");
          return new Promise((resolve,reject)=>{
            const child=spawn(process.execPath,["--import",${JSON.stringify(path.resolve("scripts/tsx.mjs"))},"--input-type=module","-e",${JSON.stringify(receiver)}],{stdio:["pipe","ignore",stderr],detached:true});
            fs.closeSync(stderr);
            child.once("error",reject);
            child.once("spawn",()=>{try{beforeInput(child.pid);child.stdin.end(JSON.stringify({action:"install",targetRoot:input.grant.root,executor:grant}));}catch(e){child.kill("SIGKILL");reject(e);}});
            child.once("exit",code=>resolve({code,stderr:"receiver exited"}));
          });
        }
        return runUtf8CommandWithTimeout([process.execPath,"--import",${JSON.stringify(path.resolve("scripts/tsx.mjs"))},"--input-type=module","-e",${JSON.stringify(receiver)}],{
          input:JSON.stringify({action:"install",targetRoot:input.grant.root,executor:grant}),beforeInput,timeoutMs:30000,killProcessTree:true,requireProcessTreeExtinction:true});
      });
      if(result.code!==0)throw new Error(result.stderr);
    });}catch(e){process.stderr.write(e.message);process.exitCode=1;}
  `;
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
                ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", spawner],
                { stdio: ["pipe", "ignore", "pipe"], detached: true },
              );
              let stderr = "";
              child.stderr.on("data", (chunk) => {
                stderr += String(chunk);
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
          [
            process.execPath,
            "--import",
            path.resolve("scripts/tsx.mjs"),
            "--input-type=module",
            "-e",
            spawner,
          ],
          {
            input: JSON.stringify({ grant }),
            beforeInput,
            timeoutMs: 40_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
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
        expect(fs.readFileSync(plist, "utf8")).toBe("next-definition");
      } else {
        expect(Object.values(results)).toHaveLength(3);
        for (const result of Object.values(results)) {
          expect(result).toMatch(/ownership.*current/);
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
  60_000,
);
