import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createManagedServiceBoundaryCleanup } from "./update-managed-service-handoff-process.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

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

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await Promise.all([...processCleanups].map((closeProcess) => closeProcess()));
    processCleanups.clear();
    for (const releaseLease of leaseCleanups) {
      releaseLease();
    }
    leaseCleanups.clear();
    cleanup();
    vi.restoreAllMocks();
    vi.resetModules();
  });
});

beforeEach(() => {
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      unref: vi.fn(),
    });
    process.nextTick(() =>
      signalMockManagedUpdateHandoffReady({
        child,
        paramsPath: args.at(-1)!,
        cleanups: leaseCleanups,
      }),
    );
    return child;
  });
});

describe("foreground update through the prepared managed helper", () => {
  it
    .runIf(process.platform !== "win32")
    .each([
      "success",
      "no-op",
      "cancel",
      "retained-lock",
      "busy-port",
      "retargeted-config",
      "stale-owner",
      "dead-parent",
      "safe-recovery",
      "unsafe-recovery",
      "lost-claim",
      "lost-terminal-claim",
      "pending-sibling",
      "pending-sibling-unsafe",
      "pending-sibling-foreign-root",
      "pending-sibling-failed-exit",
      "pending-sibling-signal",
      "admission-busy",
      "finalize-admission-busy",
      "notice-refused",
      "notice-refused-after-timeout",
    ] as const)("joins actual parent, runner IPC, owner, locks and port: %s", async (mode) => {
    const root = await fs.realpath(tempDirs.make("foreground-handoff-"));
    const coordinator = path.join(root, "coordinator");
    await fs.mkdir(coordinator);
    vi.spyOn(
      await import("./tmp-openclaw-dir.js"),
      "resolvePreferredOpenClawTmpDir",
    ).mockReturnValue(coordinator);
    const fixturePath = path.join(root, "openclaw.mjs");
    const configPath = path.join(root, "openclaw.json");
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
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
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
    const [scriptPath, paramsPath] = args;
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
      const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});
      register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
      const { registerSealedRuntime } = await import(${JSON.stringify(new URL("./sealed-runtime-registry.ts", import.meta.url).href)});
      registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ${JSON.stringify(coordinator)} });
    `;
    await fs.mkdir(path.join(root, "dist", "cli"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist", "cli", "daemon-cli.js"),
      `${bootstrap}
      const ledger = await import(${JSON.stringify(new URL("./update-run-ledger.ts", import.meta.url).href)});
      export const { adoptUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunStep, recordUpdateRunVerification } = ledger;
      const handoff = await import(${JSON.stringify(new URL("./update-managed-service-handoff.ts", import.meta.url).href)});
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
      const handoff = await import(${JSON.stringify(new URL("./update-managed-service-handoff.ts", import.meta.url).href)});
      const { readGatewayOwnerLease } = await import(${JSON.stringify(new URL("./gateway-owner-lease.ts", import.meta.url).href)});
      const { resolvePathViaExistingAncestorSync } = await import(${JSON.stringify(new URL("./boundary-path.ts", import.meta.url).href)});
      const { resolveOpenClawStateSqlitePath } = await import(${JSON.stringify(new URL("../state/openclaw-state-db.paths.ts", import.meta.url).href)});
      const { readControlPlaneUpdateSentinelMeta } = await import(${JSON.stringify(new URL("./update-control-plane-sentinel.ts", import.meta.url).href)});
      const { createUpdateRun, getUpdateRun } = await import(${JSON.stringify(new URL("./update-run-ledger.ts", import.meta.url).href)});
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
          ...(failed ? { reason: "fixture-recovery", recovery: { serviceRestartSafe: mode === "safe-recovery", version: "1.0.0" } } : {}),
          after: { version: "1.0.0" } }), resolve));
        if (failed) process.exitCode = mode === "safe-recovery" ? 1 : 79;
        if (mode === "pending-sibling-failed-exit") process.exitCode = 1;
        if (mode === "pending-sibling-signal") process.kill(process.pid, "SIGTERM");
        process.disconnect();
        }
      } else {
        const { acquireGatewayLock } = await import(${JSON.stringify(new URL("./gateway-lock.ts", import.meta.url).href)});
        const { createManagedHandoffLeaseStore } = await import(${JSON.stringify(new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href)});
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
    let failedFixture!: (error: Error) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      failedFixture = reject;
    });
    parent.stdout.on("data", (bytes) => {
      stdout += bytes;
      if (stdout.includes("FOREGROUND_FIXTURE_FAILED")) {
        failedFixture(new Error(stderr));
      }
    });
    parent.stderr.on("data", (bytes) => (stderr += bytes));
    try {
      expect(await Promise.race([parentJoined, failed]), stderr).toEqual([0, null]);
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
      expect(result.helperSignal, log).toBeNull();
      expect(result.helperCode, log).toBe(
        [
          "success",
          "no-op",
          "cancel",
          "pending-sibling",
          "pending-sibling-unsafe",
          "pending-sibling-foreign-root",
          "admission-busy",
        ].includes(mode)
          ? 0
          : mode === "unsafe-recovery"
            ? 79
            : 1,
      );
      expect(result.activated, log).toBe(
        ["success", "safe-recovery", "unsafe-recovery"].includes(mode) ||
          mode.startsWith("pending-sibling"),
      );
      expect(result.notices, log).toBe(
        [
          "no-op",
          "cancel",
          "stale-owner",
          "dead-parent",
          "lost-claim",
          "lost-terminal-claim",
          "admission-busy",
          "finalize-admission-busy",
        ].includes(mode)
          ? 0
          : 1,
      );
      expect(result.stillServing, log).toBe(
        [
          "no-op",
          "cancel",
          "stale-owner",
          "dead-parent",
          "lost-claim",
          "lost-terminal-claim",
          "admission-busy",
          "finalize-admission-busy",
        ].includes(mode),
      );
      expect(result.staged, log).toBe(
        ![
          "stale-owner",
          "dead-parent",
          "lost-claim",
          "admission-busy",
          "finalize-admission-busy",
        ].includes(mode),
      );
      expect(result.run, log).toBe(
        ["success", "lost-claim", "lost-terminal-claim"].includes(mode)
          ? "running"
          : ["no-op", "cancel", "admission-busy", "finalize-admission-busy"].includes(mode) ||
              (mode.startsWith("pending-sibling") &&
                !["pending-sibling-failed-exit", "pending-sibling-signal"].includes(mode))
            ? "skipped"
            : "failed",
      );
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
});
