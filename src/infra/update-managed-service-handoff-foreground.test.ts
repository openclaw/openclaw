import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { updateExecutorEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import { createReadyManagedServiceChild } from "./update-managed-service-handoff-command.test-support.js";
import { createManagedServiceBoundaryCleanup } from "./update-managed-service-handoff-process.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const leaseCleanups = new Set<() => void>();
const processCleanups = new Set<() => Promise<void>>();
vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as typeof import("node:child_process").spawn,
  });
});

const tempDirs = createManagedHandoffTempDirTracker();
afterEach(async () => {
  await Promise.all([...processCleanups].map((closeProcess) => closeProcess()));
  processCleanups.clear();
  for (const releaseLease of leaseCleanups) {
    releaseLease();
  }
  leaseCleanups.clear();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

beforeEach(() => {
  spawnMock.mockImplementation((_command: string, args: string[]) =>
    createReadyManagedServiceChild(args, leaseCleanups),
  );
});

it.runIf(process.platform !== "win32").each([
  // mode, exit code, activated, untouched listener, staged, ledger status
  ["success", 0, true, false, true, "running"],
  ["no-op", 0, false, true, true, "skipped"],
  ["cancel", 0, false, true, true, "skipped"],
  ["retained-lock", 1, false, false, true, "failed"],
  ["busy-port", 1, false, false, true, "failed"],
  ["retargeted-config", 1, false, false, true, "failed"],
  ["stale-owner", 1, false, true, false, "failed"],
  ["dead-parent", 1, false, true, false, "failed"],
  ["safe-recovery", 1, true, false, true, "failed"],
  ["unsafe-recovery", 79, true, false, true, "failed"],
  ["lost-claim", 1, false, true, false, "running"],
  ["lost-terminal-claim", 1, false, true, true, "running"],
  ["pending-sibling", 0, true, false, true, "skipped"],
  ["pending-sibling-unsafe", 0, true, false, true, "skipped"],
  ["pending-sibling-foreign-root", 0, true, false, true, "skipped"],
  ["pending-sibling-failed-exit", 1, true, false, true, "failed"],
  ["pending-sibling-signal", 1, true, false, true, "failed"],
  ["admission-busy", 0, false, true, false, "skipped"],
  ["finalize-admission-busy", 1, false, true, false, "skipped"],
  ["notice-refused", 1, false, false, true, "failed"],
  ["notice-refused-after-timeout", 1, false, false, true, "failed"],
] as const)("joins actual parent, runner IPC, owner, locks and port: %s", async (...outcome) => {
  const [mode, helperCode, activated, untouched, staged, run] = outcome;
  const root = await fs.realpath(tempDirs.make("foreground-handoff-"));
  const coordinator = path.join(root, "coordinator");
  await fs.mkdir(coordinator);
  vi.spyOn(await import("./tmp-openclaw-dir.js"), "resolvePreferredOpenClawTmpDir").mockReturnValue(
    coordinator,
  );
  const fixturePath = path.join(root, "openclaw.mjs");
  const configPath = path.join(root, "openclaw.json");
  const nativeProbePath = path.join(root, "native-recovery-probe");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", version: "1.0.0" }),
  );
  await fs.writeFile(path.join(root, "config-first.json"), "{}");
  await fs.writeFile(path.join(root, "config-second.json"), "{}");
  await fs.symlink(path.join(root, "config-first.json"), configPath);
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: configPath,
    PATH: process.env.PATH,
  };
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  await fs.writeFile(fixturePath, "");
  const prepared = await startManagedServiceUpdateHandoff({
    root,
    env,
    restartDrainTimeoutMs: 300_000,
    argv1: fixturePath,
    execPath: resolveTestNodeExecPath(),
    meta: {},
  });
  const [, args, spawnOptions] = spawnMock.mock.calls.at(-1) as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  tempDirs.add(path.dirname(prepared.logPath));
  const { scriptPath, paramsPath } = readManagedHandoffArtifacts(args);
  spawnMock.mock.results.at(-1)!.value.emit("exit", 0, null);
  for (const cleanup of leaseCleanups) {
    cleanup();
  }

  const bootstrap = `
      import fs from "node:fs";
      import path from "node:path";
      import net from "node:net";
      import { spawn } from "node:child_process";
      import { once } from "node:events";
      import assert from "node:assert/strict";
      const { registerSealedRuntime } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.sealedRegistry).href)});
      registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ${JSON.stringify(coordinator)} });
    `;
  await fs.mkdir(path.join(root, "dist", "cli"), { recursive: true });
  await fs.writeFile(
    path.join(root, "dist", "cli", "daemon-cli.js"),
    `${bootstrap}
      const ledger = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.ledger).href)});
      export const { adoptUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
      export async function waitForGatewayUpdateRecovery() {
        fs.writeFileSync(${JSON.stringify(nativeProbePath)}, "unexpected native service probe");
        throw new Error("Foreground recovery does not own a native service");
      }
      const handoff = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff).href)});
      export async function assertForegroundUpdateOrigin(...args) {
        await handoff.assertForegroundUpdateOrigin(...args);
        if (${JSON.stringify(mode)} === "lost-claim") {
          fs.writeFileSync(${JSON.stringify(path.join(root, "claim-check-pending"))}, "initial observation joined");
          while (!fs.existsSync(${JSON.stringify(path.join(root, "claim-check-release"))}))
            await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      if (${JSON.stringify(mode)} === "lost-terminal-claim" && process.execArgv.includes("--input-type=module")) {
        fs.writeFileSync(${JSON.stringify(path.join(root, "claim-check-pending"))}, "terminal module imported");
        while (!fs.existsSync(${JSON.stringify(path.join(root, "claim-check-release"))}))
          await new Promise(resolve => setTimeout(resolve, 10));
      }
    `,
  );
  await fs.writeFile(
    fixturePath,
    `${bootstrap}
      try {
      const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
      const unchanged = mode === "no-op" || mode === "lost-terminal-claim";
      const handoff = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff).href)});
      const { readGatewayOwnerLease } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.gatewayOwnerLease).href)});
      const { resolvePathViaExistingAncestorSync } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.boundaryPath).href)});
      const { resolveOpenClawStateSqlitePath } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.statePaths).href)});
      const { readControlPlaneUpdateSentinelMeta } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.sentinel).href)});
      const { createUpdateRun, getUpdateRun } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.ledger).href)});
      const stagePath = path.join(root, "staging"), activationPath = path.join(root, "activated");
      if (process.argv[2] === "triage") {
        process.stdout.write(JSON.stringify({ diagnostic: "fixture failure recorded" }));
      } else if (process.argv[2] === "update") {
        if (mode === "admission-busy" || mode === "finalize-admission-busy") {
          process.stdout.write(JSON.stringify({ status: "skipped", mode: mode === "admission-busy" ? "unknown" : "finalize",
            reason: "update-ledger-busy", steps: [], durationMs: 1,
            notes: ["Another writer holds update admission; retry after it settles."] }));
          process.exitCode = mode === "admission-busy" ? 0 : 1;
          process.disconnect();
        } else {
        const meta = await readControlPlaneUpdateSentinelMeta();
        const run = { runId: meta.runId, env: process.env };
        assert(await handoff.isCurrentForegroundUpdateHandoffProcess({ root, ...run }));
        for (const changed of [
          { OPENCLAW_STATE_DIR: path.join(root, "another-state") },
          { OPENCLAW_CONFIG_PATH: path.join(root, "config-second.json") },
          { OPENCLAW_UPDATE_RUN_HANDOFF: undefined },
        ]) assert.equal(await handoff.isCurrentForegroundUpdateHandoffProcess({ root, runId: run.runId, env: { ...process.env, ...changed } }), false);
        const socket = net.createConnection({ host: "127.0.0.1", port: meta.foregroundOrigin.port });
        let reply = ""; socket.on("data", bytes => reply += bytes);
        await once(socket, "end"); assert.equal(reply, "serving");
        fs.writeFileSync(stagePath, "serving with verified private lease");
        if (mode === "cancel") {
          const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          fs.writeFileSync(path.join(root, "descendant"), String(descendant.pid));
          setInterval(() => {}, 1000);
          await new Promise(() => {});
        }
        if (!unchanged) {
          await handoff.parkForegroundUpdateHandoff({ root, run });
          assert.equal(run.gatewayRestartRequired, true);
          await handoff.parkForegroundUpdateHandoff({ root, run });
          assert(await handoff.isCurrentForegroundUpdateHandoffProcess({ root, ...run }));
          fs.writeFileSync(activationPath, "closed witness accepted");
        }
        const failed = mode.endsWith("recovery");
        const pendingSibling = mode.startsWith("pending-sibling");
        const reportedRoot = mode === "pending-sibling-foreign-root" ? path.join(root, "foreign") : root;
        if (reportedRoot !== root) fs.mkdirSync(reportedRoot);
        await new Promise(resolve => process.stdout.write(JSON.stringify({ root: reportedRoot, mode: "npm", status: failed ? "error" : unchanged || pendingSibling ? "skipped" : "ok",
          ...(unchanged ? { reason: "already-current" } : {}),
          ...(pendingSibling ? { reason: "gateway-readiness-unverified", steps: [
            { name: "profile 2: gateway verification", command: "gateway verification", cwd: root, durationMs: 1, exitCode: 0,
              termination: "timeout", advisory: { kind: "recoverable-maintenance", message: "Native sibling remains starting; keep recovery backups." } },
            { name: "gateway verification", command: "gateway verification", cwd: root, durationMs: 1, exitCode: 0 },
          ] } : {}),
          ...(mode === "pending-sibling-unsafe" ? { recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" } } : {}),
          ...(failed ? { reason: "fixture-recovery", recovery: mode === "safe-recovery"
            ? { serviceRestartSafe: true, version: "1.0.0" }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" } } : {}),
          after: { version: "1.0.0" } }), resolve));
        if (failed) process.exitCode = mode === "safe-recovery" ? 1 : 79;
        if (mode === "pending-sibling-failed-exit") process.exitCode = 1;
        if (mode === "pending-sibling-signal") process.kill(process.pid, "SIGTERM");
        process.disconnect();
        }
      } else {
        const { acquireGatewayLock } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.gatewayLock).href)});
        const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.lease).href)});
        const server = net.createServer(socket => socket.end("serving"));
        server.listen(0, "127.0.0.1"); await once(server, "listening");
        const port = server.address().port;
        const run = createUpdateRun({ trigger: "api" });
        const lock = await acquireGatewayLock({ allowInTests: true, port, listenerMode: "foreground", supervisor: null });
        const owner = readGatewayOwnerLease({ current: true });
        assert(owner && owner.state === "live" && owner.startedAt !== null);
        const origin = { owner: owner.owner, pid: owner.pid, host: owner.host, startedAt: owner.startedAt, port,
          stateDatabasePath: resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(process.env)),
          configPath: resolvePathViaExistingAncestorSync(process.env.OPENCLAW_CONFIG_PATH) };
        if (mode === "stale-owner") origin.owner += "-stale";
        const paramsPath = ${JSON.stringify(paramsPath)}, scriptPath = ${JSON.stringify(scriptPath)};
        const params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
        const store = createManagedHandoffLeaseStore();
        params.parentPid = process.pid;
        params.parentStartIdentity = store.processIdentity().startIdentity;
        if (mode === "dead-parent") {
          const retired = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
          const retiredIdentity = store.processIdentity(retired.pid);
          retired.stdin.end();
          await once(retired, "close");
          params.parentPid = retired.pid; params.parentStartIdentity = retiredIdentity.startIdentity;
        }
        Object.assign(params, { foregroundOrigin: origin, serviceRecovery: undefined, runId: run.runId,
          beforePark: true, commandArgv: [process.execPath, ${JSON.stringify(fixturePath)}, "update", "--json"], nodeExecArgv: [] });
        if (mode === "safe-recovery") params.recovery = { serviceRestartSafe: true, version: "1.0.0" };
        const meta = JSON.parse(fs.readFileSync(params.metaPath, "utf8"));
        Object.assign(meta.meta, { root, runId: run.runId, foregroundOrigin: origin, completionOwner: "gateway-restart" });
        fs.writeFileSync(params.metaPath, JSON.stringify(meta));
        fs.writeFileSync(paramsPath, JSON.stringify(params));
        let notices = 0, output = "", pending = "", blocker;
        const helper = spawn(process.execPath, [scriptPath, paramsPath], { env: { ...process.env,
          OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: params.metaPath, OPENCLAW_UPDATE_RUN_ID: run.runId,
          OPENCLAW_UPDATE_RUN_HANDOFF: "1" }, stdio: ["pipe", "pipe", "pipe"] });
        let helperErrors = "";
        helper.stderr.on("data", bytes => helperErrors += bytes);
        const joined = once(helper, "close");
        helper.stdout.on("data", bytes => {
          output += bytes;
          pending += bytes;
          for (let newline; (newline = pending.indexOf("\\n")) >= 0;) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line === "OPENCLAW_UPDATE_HANDOFF_READY") helper.stdin.write("transfer\\n");
          if (line === "before-park") {
            notices++;
            void (async () => {
              if (mode === "notice-refused-after-timeout") {
                while (!fs.readFileSync(${JSON.stringify(prepared.logPath)}, "utf8").includes("pre-park notice timed out after 10 seconds"))
                  await new Promise(resolve => setTimeout(resolve, 10));
                assert(server.listening && !fs.existsSync(activationPath));
              }
              await new Promise(resolve => server.close(resolve));
              if (mode !== "retained-lock") await lock.release();
              if (mode === "retargeted-config") {
                fs.unlinkSync(process.env.OPENCLAW_CONFIG_PATH);
                fs.symlinkSync(path.join(root, "config-second.json"), process.env.OPENCLAW_CONFIG_PATH);
              }
              if (mode === "busy-port") {
                blocker = net.createServer(); blocker.listen(port, "127.0.0.1"); await once(blocker, "listening");
              }
              // One pipe write deliberately exercises notice acknowledgement and closure together.
              helper.stdin.write((mode.startsWith("notice-refused") ? "notice-failed" : "noticed") + "\\nclosed\\n");
            })().catch(error => { console.error(error); helper.stdin.write("notice-failed\\n"); });
          }
          }
        });
        if (mode === "cancel") {
          while (!fs.existsSync(path.join(root, "descendant")) && helper.exitCode === null && helper.signalCode === null)
            await new Promise(resolve => setTimeout(resolve, 10));
          helper.stdin.write("cancel\\n");
        }
        let replacement;
        if (mode === "lost-claim" || mode === "lost-terminal-claim") {
          while (!fs.existsSync(path.join(root, "claim-check-pending")) && helper.exitCode === null && helper.signalCode === null)
            await new Promise(resolve => setTimeout(resolve, 10));
          assert(fs.existsSync(path.join(root, "claim-check-pending")), "claim check was not reached");
          const current = store.read(root); assert.equal(current.kind, "current");
          // Simulate external revocation in this fixture's private database; a read
          // snapshot intentionally cannot exercise the owner's release capability.
          const { DatabaseSync } = await import("node:sqlite");
          const database = new DatabaseSync(params.updateLeaseDatabasePath);
          try {
            assert.equal(database.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ? AND payload_json = ?")
              .run(root, current.lease.owner, current.lease.payload).changes, 1);
          } finally { database.close(); }
          replacement = store.acquire(root, "replacement-owner", { kind: "update" });
          assert.equal(replacement.kind, "acquired");
          fs.writeFileSync(path.join(root, "claim-check-release"), "replacement owns the installation");
        }
        const [helperCode, helperSignal] = await joined;
        const replacementOwner = replacement && store.read(root).lease?.owner;
        if (replacement) assert(store.release(replacement.lease));
        const stillServing = server.listening && readGatewayOwnerLease({ current: true })?.owner === owner.owner;
        if (server.listening) await new Promise(resolve => server.close(resolve));
        if (blocker) await new Promise(resolve => blocker.close(resolve));
        await lock.release();
        const completedRun = getUpdateRun(run.runId);
        console.log(JSON.stringify({ mode, helperCode, helperSignal, notices, stillServing, output,
          staged: fs.existsSync(stagePath), activated: fs.existsSync(activationPath), run: completedRun?.status, runReason: completedRun?.reason,
          descendant: fs.existsSync(path.join(root, "descendant")) ? Number(fs.readFileSync(path.join(root, "descendant"))) : undefined,
          helperErrors, replacementOwner }));
      }
      } catch (error) {
        console.error(error);
        process.stdout.write("FOREGROUND_FIXTURE_FAILED\\n");
        // Retain the parent until the test owner joins its detached descendants.
        setInterval(() => {}, 1000);
      }
    `,
  );
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const parent = spawn(resolveTestNodeExecPath(), [fixturePath, "gateway", "run"], {
    env: {
      ...spawnOptions.env,
      ...env,
      OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META: undefined,
      OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cleanup = createManagedServiceBoundaryCleanup(() => [parent]);
  processCleanups.add(cleanup);
  const parentJoined = once(parent, "close");
  let stdout = "",
    stderr = "";
  const failed = createDeferred<never>();
  parent.stdout.on("data", (bytes) => {
    stdout += bytes;
    if (stdout.includes("FOREGROUND_FIXTURE_FAILED")) {
      failed.reject(new Error(stderr));
    }
  });
  parent.stderr.on("data", (bytes) => (stderr += bytes));
  try {
    expect(await Promise.race([parentJoined, failed.promise]), stderr).toEqual([0, null]);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
      helperCode: number;
      helperSignal: string | null;
      notices: number;
      stillServing: boolean;
      output: string;
      staged: boolean;
      activated: boolean;
      run: string;
      runReason: string | null;
      descendant?: number;
      replacementOwner?: string;
    };
    const log = await fs.readFile(prepared.logPath, "utf8");
    await expect(fs.access(nativeProbePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result, log).toMatchObject({
      helperSignal: null,
      helperCode,
      activated,
      notices: untouched ? 0 : 1,
      stillServing: untouched,
      staged,
      run,
    });
    if (result.notices) {
      expect(result.output, log).toContain(
        `foreground-settled:${["success", "safe-recovery", "pending-sibling"].includes(mode) ? "respawn" : "stopped"}\n`,
      );
    }
    if (mode.startsWith("pending-sibling")) {
      expect(result.runReason, log).toBe("gateway-readiness-unverified");
    }
    if (mode === "admission-busy" || mode === "finalize-admission-busy") {
      expect(result.runReason, log).toBe("update-ledger-busy");
      expect(result.output, log).not.toContain("foreground-settled:respawn");
    }
    if (result.descendant) {
      await expect.poll(() => isPidAlive(result.descendant!)).toBe(false);
    }
    if (mode === "lost-claim" || mode === "lost-terminal-claim") {
      expect(result.replacementOwner, log).toBe("replacement-owner");
    }
  } finally {
    await cleanup();
    await parentJoined;
  }
});
