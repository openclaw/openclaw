import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as entrypoints from "../../daemon/gateway-entrypoint.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  forceKillChildProcessTree,
  isChildProcessTreeAlive,
  shouldDetachChildForProcessTree,
} from "../../process/child-process-tree.js";
import * as execCommands from "../../process/exec.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { isPidAlive } from "../../shared/pid-alive.js";
import { updateExecutorEntrypoints } from "../cli-entrypoint.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutorChild,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import {
  isUpdatedInstallGatewayExecutorSupported,
  runUpdatedInstallGatewayCommand,
} from "./update-command-service-command.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { supported: true, destination: "same" },
  { supported: false, destination: "same" },
  { supported: "legacy", destination: "same" },
  { supported: true, destination: "changed" },
  { supported: true, destination: "foreign" },
])(
  "native command admits only the bound receiver: $supported / $destination",
  async ({ supported, destination }) => {
    const scratch = dirs.make("native-command-custody-");
    const receiverRoot = await fs.realpath(process.cwd());
    const root = destination === "same" ? receiverRoot : scratch;
    const targetRoot = destination === "foreign" ? scratch : receiverRoot;
    const control = path.join(scratch, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const entrypoint = path.join(scratch, "entry.mjs");
    const effect = path.join(scratch, "effect");
    const receipt = path.join(scratch, "receipt");
    const probeReceipt = path.join(scratch, "probe-receipt");
    await fs.writeFile(
      entrypoint,
      `
    process.chdir(${JSON.stringify(receiverRoot)});
    const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)});
    const {execFileUtf8}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href)});
    const fs=await import("node:fs");
    const mode=process.argv[process.argv.indexOf("--update-executor")+1];
    if(mode==="check") {
      if(!process.argv.includes("--json")) {
        process.stdout.write("Recorded warnings from the current update. ");
      }
      const {DatabaseSync}=await import("node:sqlite");
      const {createManagedHandoffLeaseStore}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.lease).href)});
      const databasePath=${JSON.stringify(path.join(control, "managed-update-handoffs.sqlite"))};
      const db=new DatabaseSync(databasePath,{readOnly:true});
      const rows=db.prepare("SELECT install_root, owner, payload_json FROM managed_update_handoffs").all();
      db.close();
      const row=rows.find(row=>JSON.parse(row.payload_json).executor.pid===process.pid);
      const lease=row?JSON.parse(row.payload_json):null;
      const store=createManagedHandoffLeaseStore({databasePath,serviceManagerEnv:process.env});
      fs.writeFileSync(${JSON.stringify(probeReceipt)},JSON.stringify({pid:process.pid,key:row?.install_root,
        owner:row?.owner,helper:lease?.helper.pid,boundStart:lease?.executor.startIdentity,
        actualStart:store.readProcessStartIdentity(process.pid)}));
    }
    if(!${JSON.stringify(supported)}) { process.stderr.write("unknown option --update-executor"); process.exitCode=1; }
    else if(mode==="check" && ${JSON.stringify(supported)}==="legacy") {
      process.stdout.write(JSON.stringify({updateExecutor:"root-spawner-v1"}));
    }
    else try { await runGatewayServiceUpdateCommand(mode,"restart",async()=>{
      fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,parent:process.ppid,noRespawn:process.env.OPENCLAW_NO_RESPAWN}));
      const result=await execFileUtf8(process.execPath,["-e",${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"owned")`)}]);
      if(result.code!==0)throw new Error(result.stderr);
      process.stdout.write(JSON.stringify({action:"restart",ok:true,result:"restarted"}));
    }); } catch(error) { process.stderr.write(error.message); process.exitCode=1; }
  `,
    );
    vi.spyOn(entrypoints, "resolveGatewayInstallEntrypoint").mockResolvedValue(entrypoint);
    const observed: unknown[] = [];
    const actualRun = execCommands.runCommandWithTimeout;
    vi.spyOn(execCommands, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const started = Date.now();
      const result = await actualRun(...args);
      observed.push({
        mode: args[0].at(-1),
        elapsedMs: Date.now() - started,
        code: result.code,
        signal: result.signal,
        termination: result.termination,
        cleanup: result.cleanup,
        killed: result.killed,
        stderr: result.stderr.slice(-1000),
      });
      return result;
    });
    const runId = randomUUID();
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      return await runUpdatedInstallGatewayCommand(
        {
          result: { root: targetRoot },
          opts: { json: true, run: { runId, env: process.env, executorFence: fence } },
          invocationEnv: process.env,
          timeoutMs: 20_000,
        },
        "restart",
      );
    }).catch((cause: unknown) => {
      throw new Error(
        `${cause instanceof Error ? cause.message : String(cause)}; native fixture runner: ${JSON.stringify(observed)}`,
        { cause },
      );
    });
    if (supported === true && destination !== "foreign") {
      expect(await work).toBe("accepted");
      expect(await fs.readFile(effect, "utf8")).toBe("owned");
      const childReceipt = JSON.parse(await fs.readFile(receipt, "utf8"));
      expect(childReceipt).toMatchObject({ parent: process.pid, noRespawn: "1" });
      expect(childReceipt.pid).not.toBe(process.pid);
    } else {
      await expect(work).rejects.toThrow(
        destination === "foreign" ? /installation|binding/ : "cannot fence",
      );
      await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receipt)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const probe = JSON.parse(await fs.readFile(probeReceipt, "utf8"));
    expect(probe).toMatchObject({ owner: runId, helper: process.pid });
    expect(probe.pid).not.toBe(process.pid);
    expect(probe.key.startsWith(root + "/.openclaw-update-child-")).toBe(true);
    expect(probe.boundStart).toBe(probe.actualStart);
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
  },
);

it.each(["receiver-root", "original-lineage", "stripped-lineage"] as const)(
  "refuses substituted native authority: %s",
  async (substitution) => {
    const scratch = dirs.make("native-receiver-grant-root-");
    const root = await fs.realpath(scratch);
    const receiverRoot = await fs.realpath(process.cwd());
    const control = path.join(root, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const effect = path.join(root, "effect");
    const receiver = `
    import {runGatewayServiceUpdateCommand} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)};
    import {execFileUtf8} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href)};
    try {
      await runGatewayServiceUpdateCommand("run", "restart", async () => {
        const result = await execFileUtf8(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"wrong-root")`)}]);
        if (result.code !== 0) throw new Error(result.stderr);
      });
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `;
    const result = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      return withUpdateCommandExecutorChild(
        fence,
        substitution === "receiver-root" ? root : receiverRoot,
        (grant, beforeInput) =>
          runUtf8CommandWithTimeout([process.execPath, "--input-type=module", "-e", receiver], {
            input: JSON.stringify({
              action: "restart",
              targetRoot: receiverRoot,
              executor:
                substitution === "receiver-root"
                  ? grant
                  : {
                      ...grant,
                      originalParent:
                        substitution === "stripped-lineage" ? undefined : grant.parent,
                      spawner: grant.parent,
                      originalChildKey:
                        substitution === "stripped-lineage" ? undefined : grant.childKey,
                    },
            }),
            beforeInput,
            cwd: receiverRoot,
            timeoutMs: 30_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          }),
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/UPDATE_NATIVE_AUTHORITY/);
    await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
  },
);

it.each([false, true])(
  "refuses equal lease rows in a retargeted database (strip pin=%s)",
  async (stripPin) => {
    const scratch = dirs.make("native-database-correlation-");
    const root = await fs.realpath(scratch);
    const receiverRoot = await fs.realpath(process.cwd());
    const control = path.join(root, "control");
    await fs.mkdir(control);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const effect = path.join(root, "effect");
    const copy = path.join(control, "copied.sqlite");
    const receiver = `
    import {runGatewayServiceUpdateCommand} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)};
    import {execFileUtf8} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExec).href)};
    try {
      await runGatewayServiceUpdateCommand("run", "restart", async () => {
        const result = await execFileUtf8(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(effect)},"copied-database")`)}]);
        if (result.code !== 0) throw new Error(result.stderr);
      });
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `;
    const result = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root);
      return withUpdateCommandExecutorChild(
        fence,
        receiverRoot,
        (grant, beforeInput) =>
          new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", receiver], {
              cwd: receiverRoot,
              stdio: ["pipe", "ignore", "pipe"],
              detached: shouldDetachChildForProcessTree(),
            });
            let stderr = "";
            const watchdog = setTimeout(() => forceKillChildProcessTree(child), 30_000);
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", reject);
            child.once("spawn", () => {
              try {
                beforeInput(child.pid!);
                // Copy only after actual PID binding has committed and closed. No
                // lease facts or process identities are fabricated in the copy.
                fsSync.copyFileSync(grant.databasePath, copy);
                child.stdin.end(
                  JSON.stringify({
                    action: "restart",
                    targetRoot: receiverRoot,
                    executor: {
                      ...grant,
                      databasePath: copy,
                      databaseIdentity: stripPin
                        ? undefined
                        : captureManagedUpdateLeaseDatabaseIdentity(copy),
                    },
                  }),
                );
              } catch (error) {
                forceKillChildProcessTree(child);
                reject(
                  error instanceof Error
                    ? error
                    : new Error("Fixture input failed", { cause: error }),
                );
              }
            });
            child.once("close", (code) => {
              clearTimeout(watchdog);
              void vi
                .waitFor(() => expect(isChildProcessTreeAlive(child)).toBe(false), {
                  timeout: 5000,
                })
                .then(
                  () => resolve({ code, stderr }),
                  (error: unknown) => {
                    forceKillChildProcessTree(child);
                    reject(
                      error instanceof Error
                        ? error
                        : new Error("Fixture tree did not settle", { cause: error }),
                    );
                  },
                );
            });
          }),
      );
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UPDATE_NATIVE_AUTHORITY");
    await expect(fs.stat(effect)).rejects.toMatchObject({ code: "ENOENT" });
    expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
  },
);

it.skipIf(process.platform === "win32").each(["cooperative", "forced"] as const)(
  "capability probe admits only successful settled cleanup: %s",
  async (cleanup) => {
    const scratch = fsSync.realpathSync(dirs.make("native-probe-settlement-"));
    const root = fsSync.realpathSync(process.cwd());
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratch);
    const entrypoint = path.join(scratch, "probe.mjs");
    const receipt = path.join(scratch, "probe-pids.json");
    const stopped = path.join(scratch, "descendant-stopped");
    const descendant = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        if (${JSON.stringify(cleanup)} === "cooperative") {
          fs.writeFileSync(${JSON.stringify(stopped)}, "settled");
          process.exit(0);
        }
      });
      setInterval(() => {}, 1000);
      process.send("ready");
    `;
    await fs.writeFile(
      entrypoint,
      `
        const { runGatewayServiceUpdateCommand } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)});
      const { spawn } = await import("node:child_process");
      const fs = await import("node:fs");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      await new Promise(resolve => child.once("message", resolve));
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ root: process.pid, child: child.pid }));
      await runGatewayServiceUpdateCommand("check", "install", async () => {
        throw new Error("Capability probe must not enter the mutation callback");
      });
      child.disconnect();
      child.unref();
    `,
    );
    vi.spyOn(entrypoints, "resolveGatewayInstallEntrypoint").mockResolvedValue(entrypoint);
    const observed: Awaited<ReturnType<typeof execCommands.runCommandWithTimeout>>[] = [];
    const actualRun = execCommands.runCommandWithTimeout;
    vi.spyOn(execCommands, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const result = await actualRun(...args);
      observed.push(result);
      return result;
    });
    try {
      const supported = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root);
        const capabilitySupported = await isUpdatedInstallGatewayExecutorSupported({
          root,
          env: process.env,
          executor: fence,
        });
        fence.assertCurrent();
        const pids = JSON.parse(await fs.readFile(receipt, "utf8"));
        expect(isChildProcessTreeAlive({ pid: pids.root })).toBe(false);
        expect(isPidAlive(pids.child)).toBe(false);
        return capabilitySupported;
      });
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ code: 0, termination: "exit", cleanup });
      expect(fsSync.existsSync(stopped)).toBe(cleanup === "cooperative");
      expect(supported).toBe(cleanup === "cooperative");
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("absent");
    } finally {
      if (fsSync.existsSync(receipt)) {
        const pids = JSON.parse(fsSync.readFileSync(receipt, "utf8"));
        if (isChildProcessTreeAlive({ pid: pids.root })) {
          process.kill(-pids.root, "SIGKILL");
        }
      }
    }
  },
  60000,
);

it.each([
  { retained: true, advertised: undefined },
  { retained: true, advertised: false },
  { retained: true, advertised: "true" },
  { retained: true, advertised: true },
  { retained: false, advertised: undefined },
])(
  "requires retained capability before private native input ($retained / $advertised)",
  async ({ retained, advertised }) => {
    const scratch = fsSync.realpathSync(dirs.make("native-retained-capability-"));
    const root = fsSync.realpathSync(process.cwd());
    const serviceRoot = path.join(scratch, "service-A");
    await fs.mkdir(serviceRoot);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratch);
    const entrypoint = path.join(scratch, "entry.mjs");
    const privateInput = path.join(scratch, "private-input");
    const effect = path.join(scratch, "effect");
    await fs.writeFile(
      entrypoint,
      `
    const fs=await import("node:fs");
    const {runGatewayServiceUpdateCommand}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.nativeExecutor).href)});
    const mode=process.argv[process.argv.indexOf("--update-executor")+1];
    if(mode==="check")process.stdout.write(${JSON.stringify(JSON.stringify({ updateExecutor: "root-spawner-v1", targetRootBinding: true, retainedOwnerBinding: advertised }))});
    else {
      process.stdin.once("data",()=>fs.writeFileSync(${JSON.stringify(privateInput)},"received"));
      await runGatewayServiceUpdateCommand(mode,"restart",async()=>{
        fs.writeFileSync(${JSON.stringify(effect)},"owned");
        process.stdout.write(JSON.stringify({action:"restart",ok:true,result:"restarted"}));
      });
    }
  `,
    );
    vi.spyOn(entrypoints, "resolveGatewayInstallEntrypoint").mockResolvedValue(entrypoint);
    const probes: Awaited<ReturnType<typeof execCommands.runCommandWithTimeout>>[] = [];
    const actualRun = execCommands.runCommandWithTimeout;
    vi.spyOn(execCommands, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const result = await actualRun(...args);
      if (args[0][args[0].indexOf("--update-executor") + 1] === "check") {
        probes.push(result);
      }
      return result;
    });
    const runId = randomUUID();
    const work = withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root, { serviceRoot: retained ? serviceRoot : undefined });
      return await runUpdatedInstallGatewayCommand(
        {
          result: { root },
          opts: { json: true, run: { runId, env: process.env, executorFence: fence } },
          invocationEnv: process.env,
        },
        "restart",
      );
    });
    if (!retained || advertised === true) {
      expect(await work).toBe("accepted");
      expect(await fs.readFile(privateInput, "utf8")).toBe("received");
      expect(await fs.readFile(effect, "utf8")).toBe("owned");
    } else {
      await expect(work).rejects.toThrow("cannot fence");
      expect(fsSync.existsSync(privateInput)).toBe(false);
      expect(fsSync.existsSync(effect)).toBe(false);
    }
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      code: 0,
      termination: "exit",
      signal: null,
      cleanup: "normal",
      killed: false,
    });
    expect(JSON.parse(probes[0]!.stdout)).toEqual({
      updateExecutor: "root-spawner-v1",
      targetRootBinding: true,
      ...(advertised === undefined ? {} : { retainedOwnerBinding: advertised }),
    });
    expect(createManagedHandoffLeaseStore().read(serviceRoot)).toEqual({ kind: "absent" });
  },
);
