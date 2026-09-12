import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runUpdateCommandRepair } from "../cli/update-cli/update-command-repair.js";
import { admitUpdateCommandRun } from "../cli/update-cli/update-command-run.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";
import { prepareUnattendedUpdateRepair } from "./update-repair-agent.js";
import type { UpdateRepairEvent, UpdateRepairParams } from "./update-repair-protocol.js";
import { withRepairExecutor } from "./update-repair.test-support.js";
import * as requesterOwner from "./update-requester-authority.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";

async function candidate(root: string, runtime: string) {
  const directory = path.join(root, "dist/infra");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "update-repair.worker.js"),
    'import "./candidate-runtime.mjs";',
  );
  await fs.writeFile(path.join(directory, "candidate-runtime.mjs"), runtime);
}

function repairParams(state: {
  stateDir: string;
  configPath: string;
  workspaceDir: string;
}): UpdateRepairParams {
  return {
    target: { ...state, installRoot: state.workspaceDir },
    context: { error: "Synthetic startup failure", phase: "verifying" },
    budget: { maxTurns: 1, wallClockMs: 10_000 },
    validate: async () => ({ ok: false, score: 0, summary: "Service stopped" }),
  };
}

function prepareOwnedRepair(params: UpdateRepairParams) {
  return withRepairExecutor(params, prepareUnattendedUpdateRepair);
}

describe("fresh candidate repair process", () => {
  it.skipIf(process.platform === "win32")(
    "keeps both installations busy after updater death until the repair process exits",
    async () => {
      await withOpenClawTestState(
        { prefix: "repair-child-custody-", layout: "home" },
        async (state) => {
          const original = state.path("original");
          const staged = state.path("staged");
          const control = state.path("control");
          await fs.mkdir(original);
          await fs.mkdir(control, { mode: 0o700 });
          const pidPath = state.path("repair-pid");
          await candidate(
            staged,
            `
          import fs from "node:fs";
          setInterval(() => {}, 1000);
          // A draining repair can outlive its disconnected updater.
          process.on("disconnect", () => {});
          process.on("message", message => {
            if (message.type !== "start") return;
            fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
            if (!message.turn) process.send({ type: "validate", id: 1 });
          });
          process.send({ type: "ready", candidateRehearsal: true, repairTurns: true, executorDelegation: "pid-start-v1" });
        `,
          );
          const databasePath = path.join(control, "managed-update-handoffs.sqlite");
          const identity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
            captureManagedUpdateLeaseDatabaseIdentity(databasePath),
          );
          const runId = randomUUID();
          const program = `
          import fs from "node:fs";
          import { withUpdateCommandExecutor } from ${JSON.stringify(new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href)};
          import { prepareUnattendedUpdateRepair } from ${JSON.stringify(new URL("./update-repair-agent.ts", import.meta.url).href)};
          await withUpdateCommandExecutor(${JSON.stringify(runId)}, async owner => {
            const executorFence = await owner.enter(${JSON.stringify(original)});
            const readyTimer = setInterval(() => {
              if (fs.existsSync(${JSON.stringify(pidPath)})) {
                clearInterval(readyTimer);
                process.stdout.write("ready:" + fs.readFileSync(${JSON.stringify(pidPath)}, "utf8") + "\\n");
              }
            }, 10);
            await prepareUnattendedUpdateRepair({
              executorFence,
              runId: ${JSON.stringify(runId)},
              target: ${JSON.stringify({ ...repairParams(state).target, installRoot: staged })},
              context: { phase: "validating", error: "Synthetic update failure" },
              budget: { wallClockMs: 30000 },
              validate: async () => ({ ok: false, score: 0, summary: "Update failed" }),
            });
          }, { existingAuthority: ${JSON.stringify({ ...identity, installKey: original })} });
        `;
          const updater = spawn(
            process.execPath,
            ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", program],
            {
              env: { ...state.env, ESBUILD_WORKER_THREADS: "0" },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const exited = once(updater, "exit");
          const ready = createDeferred<number>();
          let output = "";
          let errors = "";
          updater.stdout.on("data", (chunk) => {
            output += String(chunk);
            const match = /^ready:(\d+)$/m.exec(output);
            if (match) {
              ready.resolve(Number(match[1]));
            }
          });
          updater.stderr.on("data", (chunk) => {
            errors += String(chunk);
          });
          let pid: number | undefined;
          const store = createManagedHandoffLeaseStore({
            databasePath,
            serviceManagerEnv: resolveServiceManagerEnv(),
            existingIdentity: identity,
          });
          const acquireBoth = () =>
            [original, staged].map((root) => {
              const acquired = store.acquire(root, "next-update", { kind: "update" });
              if (acquired.kind === "acquired") {
                expect(store.release(acquired.lease)).toBe(true);
              }
              return acquired.kind;
            });
          try {
            pid = await Promise.race([
              ready.promise,
              exited.then(() => {
                throw new Error(errors || "Updater exited before repair startup");
              }),
            ]);
            updater.kill("SIGKILL");
            await exited;
            expect(isChildProcessTreeAlive({ pid })).toBe(true);
            expect(acquireBoth()).toEqual(["busy", "busy"]);
          } finally {
            updater.kill("SIGKILL");
            await exited;
            pid ??= Number(await fs.readFile(pidPath, "utf8").catch(() => "0")) || undefined;
            killPidIfAlive(pid);
            if (pid) {
              await vi.waitFor(() => expect(isChildProcessTreeAlive({ pid })).toBe(false), {
                timeout: 5000,
                interval: 25,
              });
            }
          }
          expect(acquireBoth()).toEqual(["acquired", "acquired"]);
        },
      );
    },
    45000,
  );

  it.each([
    {
      source: "external",
      requester: { channel: "synthetic", senderId: "owner" },
      needsAuthority: true,
    },
    {
      source: "internal",
      requester: { channel: "webchat", senderId: "owner" },
      needsAuthority: false,
    },
    { source: "channel-less", requester: { senderId: "owner" }, needsAuthority: false },
  ])(
    "preserves $source requester authority through replacement and candidate repair",
    async ({ requester, needsAuthority }) => {
      await withOpenClawTestState(
        {
          prefix: "repair-child-boundary-",
          layout: "home",
          env: { [UPDATE_RUN_ID_ENV]: undefined },
        },
        async (state) => {
          await state.writeConfig({
            commands: { ownerAllowFrom: needsAuthority ? ["owner"] : [] },
            plugins: { enabled: false },
            agents: { defaults: { model: { primary: "unconfigured/repair" } } },
          });
          const obsolete = path.join(state.workspaceDir, "old-runtime.mjs");
          await fs.writeFile(
            obsolete,
            'throw new Error("Old runtime cannot execute after replacement");',
          );
          await candidate(
            state.workspaceDir,
            `
        import fs from "node:fs";
        process.on("message", message => {
          if (message.type !== "start") return;
          const expectedRequester = ${JSON.stringify(needsAuthority ? requester : null)};
          if (JSON.stringify(message.requester ?? null) !== JSON.stringify(expectedRequester)) process.exit(8);
          fs.writeFileSync("child-pid", String(process.pid));
          process.send({ type: "event", event: { type: "route-selected", provider: "openai", model: "gpt-5.6-luna" } });
          fs.writeFileSync("candidate-repaired", message.target.stateDir);
          process.send({ type: "turn-result", result: { status: "completed", provider: "openai", model: "gpt-5.6-luna", toolCalls: 1, summary: "Update repair completed.", timedOut: false } }, () => process.disconnect());
        });
        process.send({ type: "ready", repairTurns: true, executorDelegation: "pid-start-v1" });
      `,
          );
          const prepareAuthority = requesterOwner.createManagedUpdateRequesterAuthority;
          // A late factory call would import chunks removed by replacement. Keep
          // that module-availability boundary observable without touching this checkout.
          const prepare = vi
            .spyOn(requesterOwner, "createManagedUpdateRequesterAuthority")
            .mockImplementation(async (...args) => {
              await fs.access(obsolete);
              return prepareAuthority(...args);
            });
          try {
            const requested = createUpdateRun(
              {
                trigger: needsAuthority ? "chat" : "api",
                origin: { requester },
              },
              { env: state.env },
            );
            process.env[UPDATE_RUN_ID_ENV] = requested.runId;
            const run = await admitUpdateCommandRun({ opts: {}, root: state.workspaceDir });
            // The candidate passed staging without entering repair. Its first repair
            // occurs only after activation, when the parent cannot load old modules.
            recordUpdateRunPhase(
              run.runId,
              "validating",
              {
                step: { step: "candidate validation", status: "completed" },
              },
              { env: run.env },
            );
            recordUpdateRunPhase(run.runId, "verifying", undefined, { env: run.env });
            expect(getUpdateRun(run.runId, { env: run.env })?.repair).toEqual([]);
            await fs.rm(obsolete);
            const events: UpdateRepairEvent[] = [];
            let validations = 0;
            let restarts = 0;
            const result = await withRepairExecutor(
              { ...repairParams(state), runId: run.runId },
              async ({ executorFence }) => {
                run.executorFence = executorFence;
                return await runUpdateCommandRepair({
                  root: state.workspaceDir,
                  env: run.env,
                  run,
                  phase: "verifying",
                  result: {
                    status: "error",
                    mode: "npm",
                    root: state.workspaceDir,
                    reason: "startup-failed",
                    steps: [],
                    durationMs: 0,
                  },
                  onEvent: (event) => events.push(event),
                  validate: async (signal) => {
                    signal.throwIfAborted();
                    validations += 1;
                    run.executorFence?.assertCurrent();
                    const repaired = await fs
                      .readFile(path.join(state.workspaceDir, "candidate-repaired"), "utf8")
                      .catch(() => "");
                    if (repaired) {
                      const childPid = Number(
                        await fs.readFile(path.join(state.workspaceDir, "child-pid"), "utf8"),
                      );
                      expect(childPid).not.toBe(process.pid);
                      expect(isChildProcessTreeAlive({ pid: childPid })).toBe(false);
                      expect(repaired).toBe(state.stateDir);
                      expect(events.at(-1)?.type).toBe("turn-started");
                      restarts += 1;
                    }
                    return {
                      ok: Boolean(repaired),
                      score: repaired ? 1 : 0,
                      summary: repaired ? "Parent verified restart" : "Service stopped",
                    };
                  },
                });
              },
            );
            expect(result).toMatchObject({
              status: "repaired",
              attempts: [{ validation: { ok: true } }],
            });
            expect(validations).toBe(2);
            expect(restarts).toBe(1);
            expect(prepare).toHaveBeenCalledTimes(needsAuthority ? 1 : 0);
            expect(getUpdateRun(run.runId, { env: run.env })?.origin.requester).toEqual(requester);
            expect(getUpdateRun(run.runId, { env: run.env })?.repair).toEqual([
              expect.objectContaining({ status: "succeeded" }),
            ]);
            expect(events.map((event) => event.type)).toEqual([
              "validation",
              "route-selected",
              "turn-started",
              "validation",
              "turn-finished",
              "stopped",
            ]);
          } finally {
            prepare.mockRestore();
          }
        },
      );
    },
  );

  it("keeps admission separate from the rehearsal environment sent to the child", async () => {
    await withOpenClawTestState({ prefix: "repair-child-env-", layout: "home" }, async (state) => {
      const reported = [
        "HOME",
        "TMPDIR",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_WORKSPACE_DIR",
        "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR",
        "PATH",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "OPENCLAW_SYNTHETIC_UNTRUSTED",
        "OPENCLAW_UPDATE_RUN_HANDOFF",
      ];
      await candidate(
        state.workspaceDir,
        `
        import fs from "node:fs";
        const send = message => process.send(message);
        process.on("message", message => {
          if (message.type === "start") {
            fs.writeFileSync("repair-child-env.json", JSON.stringify({
              admission: Object.fromEntries(${JSON.stringify(reported)}.map(key => [key, process.env[key]])),
              rehearsal: message.target.environment,
            }));
            send({ type: "event", event: { type: "route-selected", provider: "openai", model: "gpt-5.6-luna" } });
            process.send({ type: "turn-result", result: { status: "completed", provider: "openai", model: "gpt-5.6-luna", toolCalls: 0, summary: "Environment captured.", timedOut: false } }, () => process.disconnect());
          }
        });
        send({ type: "ready", repairTurns: true, executorDelegation: "pid-start-v1" });
      `,
      );
      const before = { ...process.env };
      const admissionEnv: NodeJS.ProcessEnv = {
        ...state.env,
        TMPDIR: state.path("admission-temp"),
      };
      const result = await prepareOwnedRepair({
        ...repairParams(state),
        validate: async () => ({
          ok: await fs.access(path.join(state.workspaceDir, "repair-child-env.json")).then(
            () => true,
            () => false,
          ),
          score: 0,
          summary: "Environment captured",
        }),
        admissionEnv,
        target: {
          stateDir: state.stateDir,
          configPath: state.configPath,
          workspaceDir: state.workspaceDir,
          installRoot: state.workspaceDir,
          environment: {
            ...process.env,
            HOME: state.home,
            TMPDIR: state.root,
            OPENCLAW_HOME: state.home,
            OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
            NODE_OPTIONS: "--no-warnings",
            PATH: "/synthetic-untrusted-bin",
            LD_PRELOAD: "/synthetic-preload.so",
            DYLD_INSERT_LIBRARIES: "/synthetic-preload.dylib",
            OPENCLAW_SYNTHETIC_UNTRUSTED: "untrusted",
          },
        },
      });

      expect(result, JSON.stringify(result)).toMatchObject({ status: "repaired" });
      const captured = JSON.parse(
        await fs.readFile(path.join(state.workspaceDir, "repair-child-env.json"), "utf8"),
      );
      expect(captured.admission).toEqual(
        Object.fromEntries(
          reported
            .filter((key) => admissionEnv[key] !== undefined)
            .map((key) => [key, admissionEnv[key]]),
        ),
      );
      expect(captured.rehearsal).toMatchObject({
        TMPDIR: state.root,
        PATH: "/synthetic-untrusted-bin",
        LD_PRELOAD: "/synthetic-preload.so",
      });
      expect(captured.rehearsal).not.toHaveProperty("OPENCLAW_UPDATE_RUN_HANDOFF");
      // Rehearsal projection and host filtering belong to the shared runtime scope.
      expect(process.env).toEqual(before);
    });
  });

  it("cancels and joins the repair child before releasing the repair slot", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-cancel-", layout: "home" },
      async (state) => {
        await candidate(
          state.workspaceDir,
          `
        import fs from "node:fs";
        process.on("message", message => {
          if (message.type === "start") {
            fs.writeFileSync("repair-pid", String(process.pid));
            process.send({ type: "event", event: { type: "route-selected", model: "gpt-5.6-luna", provider: "openai" } });
          }
        });
        process.send({ type: "ready", repairTurns: true, executorDelegation: "pid-start-v1" });
      `,
        );
        const controller = new AbortController();
        const entered = createDeferred();
        let admitted: UpdateRepairParams | undefined;
        const pending = withRepairExecutor(
          {
            ...repairParams(state),
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "turn-started") {
                entered.resolve();
              }
            },
          },
          async (owned) => {
            admitted = owned;
            return await prepareUnattendedUpdateRepair(owned);
          },
        );
        await entered.promise;
        if (!admitted) {
          throw new Error("Repair fixture did not acquire its executor.");
        }
        await expect(prepareUnattendedUpdateRepair(admitted)).resolves.toMatchObject({
          status: "unavailable",
          reason: "Another installation repair is already running.",
        });
        controller.abort(new Error("repair-cancelled"));
        await expect(pending).resolves.toMatchObject({
          status: "aborted",
          reason: "repair-cancelled",
        });
        const pid = Number(await fs.readFile(path.join(state.workspaceDir, "repair-pid"), "utf8"));
        expect(isChildProcessTreeAlive({ pid })).toBe(false);
      },
    );
  });

  it.each([
    { phase: "validating" as const, ready: {} },
    { phase: "verifying" as const, ready: { repairTurns: true } },
  ])(
    "refuses unsupported worker execution before start during $phase",
    async ({ phase, ready }) => {
      await withOpenClawTestState(
        { prefix: "repair-old-worker-", layout: "home" },
        async (state) => {
          await candidate(
            state.workspaceDir,
            `
        import fs from "node:fs";
        process.on("message", () => fs.writeFileSync("unexpected-start", "started"));
        process.send({ type: "ready", ...${JSON.stringify(ready)} });
        `,
          );
          const result = await prepareOwnedRepair({
            ...repairParams(state),
            context: { error: "Update validation failed.", phase },
          });
          expect(result).toMatchObject({
            status: "unavailable",
            reason: expect.stringContaining("cannot safely run automatic update repair"),
          });
          await expect(
            fs.stat(path.join(state.workspaceDir, "unexpected-start")),
          ).rejects.toMatchObject({
            code: "ENOENT",
          });
        },
      );
    },
  );

  it("records an unavailable candidate worker instead of falling back to old imports", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-missing-", layout: "home" },
      async (state) => {
        const events: UpdateRepairEvent[] = [];
        const result = await prepareOwnedRepair({
          ...repairParams(state),
          onEvent: (event) => events.push(event),
        });
        expect(result.status, JSON.stringify(result)).toBe("unavailable");
        expect(events.at(-1)).toMatchObject({ type: "stopped", status: "unavailable" });
      },
    );
  });
});
