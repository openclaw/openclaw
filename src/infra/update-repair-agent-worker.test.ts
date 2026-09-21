import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runUpdateCommandRepair } from "../cli/update-cli/update-command-repair.js";
import { admitUpdateCommandRun } from "../cli/update-cli/update-command-run.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { toErrorObject } from "./errors.js";
import * as rehearsalOwner from "./update-candidate-rehearsal.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { prepareUnattendedUpdateRepair } from "./update-repair-agent.js";
import {
  updateRepairParentMessageSchema,
  type UpdateRepairEvent,
  type UpdateRepairParams,
} from "./update-repair-protocol.js";
import * as requesterOwner from "./update-requester-authority.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunPhase } from "./update-run-ledger.js";
import { renderUpdateRunReport } from "./update-run-report.js";

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

describe("fresh candidate repair process", () => {
  it.each(["Required recovery check failed.\n".repeat(80), "🚀 Recovery failed.\n".repeat(80)])(
    "delivers long validation summaries within the existing wire limit (%#)",
    async (details) => {
      await withOpenClawTestState({ prefix: "repair-summary-boundary-" }, async (state) => {
        await candidate(
          state.workspaceDir,
          `
          import fs from "node:fs";
          process.on("message", message => {
            if (message.type === "start") process.send({ type: "validate", id: 1 });
            if (message.type === "validation-result") {
              fs.writeFileSync("validation.json", JSON.stringify(message));
              process.send({ type: "result", result: {
                status: "unavailable", attempts: [], finalValidation: message.validation,
                reason: "No usable inference route."
              } }, () => process.disconnect());
            }
          });
          process.send({ type: "ready", candidateRehearsal: true });
        `,
        );
        const result = await prepareUnattendedUpdateRepair({
          ...repairParams(state),
          validate: async () => ({
            ok: false,
            score: 0,
            summary: details,
          }),
        });
        expect(result).toMatchObject({
          status: "unavailable",
          reason: "No usable inference route.",
        });
        const received: unknown = JSON.parse(
          await fs.readFile(path.join(state.workspaceDir, "validation.json"), "utf8"),
        );
        const message = updateRepairParentMessageSchema.parse(received);
        expect(message.type).toBe("validation-result");
        if (message.type !== "validation-result") {
          throw new Error("Missing validation result");
        }
        expect(message.validation.summary.length).toBeLessThanOrEqual(1024);
        expect(details.startsWith(message.validation.summary)).toBe(true);
        expect(message.validation.summary).not.toBe("");
      });
    },
  );

  it.each([
    { phase: "verifying", failure: "cleanup", retainedRehearsal: false },
    { phase: "validating", failure: "wrapped-cleanup", retainedRehearsal: false },
    { phase: "validating", failure: "ordinary", retainedRehearsal: false },
    { phase: "validating", failure: "wrapped-cleanup", retainedRehearsal: true },
    { phase: "validating", failure: "ordinary", retainedRehearsal: true },
  ] as const)(
    "settles the repair child before propagating $failure during $phase (retained=$retainedRehearsal)",
    async ({ phase, failure, retainedRehearsal }) => {
      await withOpenClawTestState(
        {
          prefix: "repair-child-cleanup-",
          layout: "home",
          env: { [UPDATE_RUN_ID_ENV]: undefined },
        },
        async (state) => {
          await state.writeConfig({ plugins: { enabled: false } });
          await candidate(
            state.workspaceDir,
            `
        import fs from "node:fs";
        const finish = () => {
          process.send({ type: "event", event: { type: "stopped", status: "aborted", reason: "Synthetic validation failed" } });
          process.send({ type: "result", result: {
            status: "aborted", attempts: [], reason: "Synthetic validation failed",
            finalValidation: { ok: false, score: 0, summary: "Synthetic validation failed" }
          } }, () => process.disconnect());
        };
        process.on("SIGTERM", finish);
        process.on("message", message => {
          if (message.type === "start") {
            fs.writeFileSync("child-pid", String(process.pid));
            process.send({ type: "validate", id: 1 });
          } else if (message.type === "validation-result" && message.id === 1) {
            fs.writeFileSync("cached-validation", JSON.stringify(message.validation));
            process.send({ type: "validate", id: 2 });
          } else if (message.type === "validation-error") {
            fs.writeFileSync("validation-error", "received");
            finish();
          }
        });
        process.send({ type: "ready", candidateRehearsal: true });
      `,
          );
          const rehearsalDir = state.path("rehearsal");
          await fs.mkdir(rehearsalDir);
          const retained = path.join(rehearsalDir, "recovery-input");
          await fs.writeFile(retained, "Retain while command cleanup is uncertain.");
          const cleanup = vi.fn(async () => {
            await fs.rm(rehearsalDir, { recursive: true });
          });
          const rehearsal: rehearsalOwner.UpdateCandidateRehearsal = {
            sourceConfig: { plugins: { enabled: false } },
            sourceConfigHash: "synthetic-config-hash",
            stateDir: rehearsalDir,
            configPath: path.join(rehearsalDir, "openclaw.json"),
            workspaceDir: path.join(rehearsalDir, "workspace"),
            env: state.env,
            port: 0,
            snapshotCapacity: {
              reason: "state-volume",
              sqliteBytes: 0,
              pluginBytes: 0,
              requiredBytes: 0,
              candidates: [],
              selection: { kind: "state-volume", directory: rehearsalDir },
            },
            cleanupDirectories: [rehearsalDir],
            cleanup,
          };
          const prepare = vi
            .spyOn(rehearsalOwner, "prepareUpdateCandidateRehearsal")
            .mockImplementationOnce(async ({ config, sourceConfigHash }) => ({
              ...rehearsal,
              sourceConfig: config,
              sourceConfigHash,
            }));
          const canonical = new CommandProcessCleanupError();
          const error =
            failure === "ordinary"
              ? new Error("Synthetic validation failed")
              : failure === "wrapped-cleanup"
                ? new Error("Validation could not settle", { cause: canonical })
                : canonical;
          const run = {
            runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
            env: state.env,
          };
          const events: UpdateRepairEvent[] = [];
          const validate = vi.fn(async () => {
            throw error;
          });
          try {
            const outcome = await runUpdateCommandRepair({
              root: state.workspaceDir,
              env: state.env,
              run,
              ...(phase === "validating"
                ? {
                    phase,
                    candidateRoot: state.workspaceDir,
                    mode: "npm" as const,
                    validation: {
                      status: "error" as const,
                      reason: "runtime-verification-failed" as const,
                      phase: "runtime" as const,
                      steps: [],
                      durationMs: 0,
                      logTail: ["Synthetic validation failed"],
                      ...(retainedRehearsal ? { retainedRehearsal: { rehearsal, cleanup } } : {}),
                    },
                  }
                : {
                    phase,
                    result: {
                      status: "error" as const,
                      mode: "npm" as const,
                      root: state.workspaceDir,
                      steps: [],
                      durationMs: 0,
                    },
                  }),
              onEvent: (event) => events.push(event),
              validate,
            }).then(
              (value) => ({ value }),
              (cause: unknown) => ({ error: cause }),
            );
            const childPid = Number(
              await fs.readFile(path.join(state.workspaceDir, "child-pid"), "utf8"),
            );
            expect(isPidAlive(childPid)).toBe(false);
            expect(validate).toHaveBeenCalledOnce();
            expect(prepare).toHaveBeenCalledTimes(
              phase === "validating" && !retainedRehearsal ? 1 : 0,
            );
            if (retainedRehearsal) {
              expect(
                JSON.parse(
                  await fs.readFile(path.join(state.workspaceDir, "cached-validation"), "utf8"),
                ),
              ).toEqual({ ok: false, score: 0, summary: "Synthetic validation failed" });
            }
            const repairing = getUpdateRun(run.runId, { env: run.env })?.steps.find(
              (step) => step.step === "repairing",
            );
            if (failure === "ordinary") {
              expect(outcome).toMatchObject({ value: { status: "aborted" } });
              expect(cleanup).toHaveBeenCalledOnce();
              expect(repairing?.status).toBe("failed");
            } else {
              expect.soft("error" in outcome ? outcome.error : undefined).toBe(error);
              expect.soft(events).toEqual([]);
              expect.soft(repairing?.status).toBe("in_progress");
              expect.soft(cleanup).not.toHaveBeenCalled();
              await expect.soft(fs.readFile(retained, "utf8")).resolves.toContain("Retain");
              await expect
                .soft(fs.stat(path.join(state.workspaceDir, "validation-error")))
                .rejects.toMatchObject({ code: "ENOENT" });
            }
          } finally {
            prepare.mockRestore();
          }
        },
      );
    },
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
        let start;
        const send = message => process.send(message);
        process.on("message", message => {
          if (message.type === "start") {
            start = message;
            const expectedRequester = ${JSON.stringify(needsAuthority ? requester : null)};
            if (JSON.stringify(start.requester ?? null) !== JSON.stringify(expectedRequester)) process.exit(8);
            fs.writeFileSync("child-pid", String(process.pid));
            send({ type: "validate", id: 1 });
          } else if (message.type === "validation-result" && message.id === 1) {
            send({ type: "event", event: { type: "turn-started", turn: 1, provider: "openai", model: "gpt-5.6-luna" } });
            fs.writeFileSync("candidate-repaired", start.target.stateDir);
            send({ type: "validate", id: 2 });
          } else if (message.type === "validation-result" && message.id === 2) {
            const attempt = { turn: 1, provider: "openai", model: "gpt-5.6-luna", durationMs: 1, toolCalls: 1, validation: message.validation, summary: "Candidate repair completed." };
            send({ type: "event", event: { type: "turn-finished", ...attempt } });
            send({ type: "event", event: { type: "stopped", status: "repaired" } });
            process.send({ type: "result", result: { status: "repaired", attempts: [attempt], finalValidation: message.validation } }, () => process.disconnect());
          }
        });
        send({ type: "ready", candidateRehearsal: true });
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
            const result = await runUpdateCommandRepair({
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
                const childPid = Number(
                  await fs.readFile(path.join(state.workspaceDir, "child-pid"), "utf8"),
                );
                expect(childPid).not.toBe(process.pid);
                const repaired = await fs
                  .readFile(path.join(state.workspaceDir, "candidate-repaired"), "utf8")
                  .catch(() => "");
                if (repaired) {
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
              "turn-started",
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

  it("keeps unavailable inference separate from the update failure it could not repair", async () => {
    await withOpenClawTestState({ prefix: "repair-no-route-", layout: "home" }, async (state) => {
      const failure = "Doctor completed, then failed to exit (killed at 299 s)";
      const reason = "No usable, authenticated, tool-capable inference route could be verified.";
      await candidate(
        state.workspaceDir,
        `
        process.on("message", message => {
          if (message.type !== "start") return;
          const result = { status: "unavailable", attempts: [], reason: ${JSON.stringify(reason)},
            finalValidation: { ok: false, score: 0, summary: ${JSON.stringify(failure)} } };
          process.send({ type: "event", event: { type: "stopped", status: result.status, reason: result.reason } });
          process.send({ type: "result", result }, () => process.disconnect());
        });
        process.send({ type: "ready", candidateRehearsal: true });
        `,
      );
      const admitted = createUpdateRun({ trigger: "cli" }, { env: state.env });
      recordUpdateRunPhase(
        admitted.runId,
        "verifying",
        { step: { step: "Checking update health", status: "failed", detail: failure } },
        { env: state.env },
      );
      await runUpdateCommandRepair({
        root: state.workspaceDir,
        env: state.env,
        run: { runId: admitted.runId, env: state.env },
        phase: "verifying",
        result: {
          status: "error",
          mode: "npm",
          root: state.workspaceDir,
          reason: "doctor-failed",
          steps: [],
          durationMs: 299_000,
        },
        validate: async () => ({ ok: false, score: 0, summary: failure }),
      });
      const recorded = getUpdateRun(admitted.runId, { env: state.env })!;
      expect(recorded.steps.find((step) => step.step === "repairing")?.status).toBe("skipped");
      expect(recorded.repair).toMatchObject([{ status: "skipped", reason }]);
      const report = renderUpdateRunReport({
        ...recorded,
        status: "failed",
        reason: "doctor-failed",
      });
      expect(report.markdown).toContain(`Failed: Checking update health — ${failure}`);
      expect(report.markdown).toContain(`Repair 1: skipped — ${reason}`);
      expect(report.markdown).not.toContain("Failed: repairing");
    });
  });

  it("repairs a candidate rehearsal in the staged candidate runtime", async () => {
    await withOpenClawTestState(
      { prefix: "repair-candidate-rehearsal-", layout: "home" },
      async (state) => {
        // The candidate owns rehearsal state it has already migrated to its own
        // schema. Only its runtime may open that state during pre-activation repair.
        const candidateRoot = path.join(state.workspaceDir, "candidate");
        await candidate(
          candidateRoot,
          `
        import fs from "node:fs";
        const send = message => process.send(message);
        process.on("message", message => {
          if (message.type === "start") {
            fs.writeFileSync("candidate-repair-pid", String(process.pid));
            fs.writeFileSync("candidate-repair-state", message.target.stateDir);
            send({ type: "validate", id: 1 });
          } else if (message.type === "validation-result") {
            const attempt = { turn: 1, provider: "openai", model: "gpt-5.6-luna", durationMs: 1, toolCalls: 1, validation: { ok: true, score: 1, summary: "Candidate rehearsal repaired." }, summary: "Candidate rehearsal repaired." };
            send({ type: "event", event: { type: "turn-started", turn: 1, provider: attempt.provider, model: attempt.model } });
            send({ type: "event", event: { type: "turn-finished", ...attempt } });
            send({ type: "event", event: { type: "stopped", status: "repaired" } });
            process.send({ type: "result", result: { status: "repaired", attempts: [attempt], finalValidation: attempt.validation } }, () => process.disconnect());
          }
        });
        send({ type: "ready", candidateRehearsal: true });
      `,
        );
        const rehearsalStateDir = state.path("rehearsal");
        await fs.mkdir(rehearsalStateDir, { recursive: true });
        const result = await prepareUnattendedUpdateRepair({
          target: {
            stateDir: rehearsalStateDir,
            configPath: path.join(rehearsalStateDir, "openclaw.json"),
            workspaceDir: path.join(rehearsalStateDir, "workspace"),
            installRoot: candidateRoot,
          },
          context: { error: "Candidate lint failed", phase: "validating" },
          budget: { maxTurns: 1, wallClockMs: 30_000 },
          validate: async () => ({ ok: false, score: 0, summary: "Candidate lint failed" }),
        });

        expect(result, JSON.stringify(result)).toMatchObject({ status: "repaired" });
        const pid = Number(
          await fs.readFile(path.join(candidateRoot, "candidate-repair-pid"), "utf8"),
        );
        expect(pid).not.toBe(process.pid);
        expect(await fs.readFile(path.join(candidateRoot, "candidate-repair-state"), "utf8")).toBe(
          rehearsalStateDir,
        );
      },
    );
  });

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
            const validation = { ok: true, score: 1, summary: "Environment captured." };
            send({ type: "event", event: { type: "stopped", status: "repaired" } });
            process.send({ type: "result", result: { status: "repaired", attempts: [], finalValidation: validation } }, () => process.disconnect());
          }
        });
        send({ type: "ready", candidateRehearsal: true });
      `,
      );
      const before = { ...process.env };
      const admissionEnv: NodeJS.ProcessEnv = {
        ...state.env,
        TMPDIR: state.path("admission-temp"),
      };
      const result = await prepareUnattendedUpdateRepair({
        ...repairParams(state),
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

  it("cancels the child and drains the parent oracle before returning", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-cancel-", layout: "home" },
      async (state) => {
        await candidate(
          state.workspaceDir,
          `
        process.on("message", message => {
          if (message.type === "start") process.send({ type: "validate", id: 1 });
        });
        process.send({ type: "ready", candidateRehearsal: true });
      `,
        );
        const controller = new AbortController();
        const { promise: entered, resolve: admitted } = createDeferred();
        let drained = false;
        const pending = prepareUnattendedUpdateRepair({
          ...repairParams(state),
          signal: controller.signal,
          validate: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  drained = true;
                  reject(toErrorObject(signal.reason, "Repair validation cancelled."));
                },
                { once: true },
              );
              admitted();
            }),
        });
        await entered;
        await expect(prepareUnattendedUpdateRepair(repairParams(state))).resolves.toMatchObject({
          status: "unavailable",
          reason: "Another installation repair is already running.",
        });
        controller.abort(new Error("repair-cancelled"));
        await expect(pending).resolves.toMatchObject({
          status: "aborted",
          reason: "repair-cancelled",
        });
        expect(drained).toBe(true);
      },
    );
  });

  it("refuses a worker that cannot separate live authority from its repair target", async () => {
    await withOpenClawTestState({ prefix: "repair-old-worker-", layout: "home" }, async (state) => {
      await candidate(
        state.workspaceDir,
        `
        import fs from "node:fs";
        process.on("message", () => fs.writeFileSync("unexpected-start", "started"));
        process.send({ type: "ready" });
        `,
      );
      const result = await prepareUnattendedUpdateRepair({
        ...repairParams(state),
        context: { error: "Candidate validation failed.", phase: "validating" },
      });
      expect(result).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("cannot safely repair the temporary update copy"),
      });
      await expect(
        fs.stat(path.join(state.workspaceDir, "unexpected-start")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("records an unavailable candidate worker instead of falling back to old imports", async () => {
    await withOpenClawTestState(
      { prefix: "repair-child-missing-", layout: "home" },
      async (state) => {
        const events: UpdateRepairEvent[] = [];
        const result = await prepareUnattendedUpdateRepair({
          ...repairParams(state),
          onEvent: (event) => events.push(event),
        });
        expect(result.status).toBe("unavailable");
        expect(events).toEqual([
          expect.objectContaining({ type: "stopped", status: "unavailable" }),
        ]);
      },
    );
  });
});
