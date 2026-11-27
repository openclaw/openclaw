import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { prepareSessionEventInput } from "../auto-reply/reply/session-event-context.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  readLatestSessionTranscriptReport,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginGatewayBootLifecycle,
  completeGatewayBootLifecycle,
} from "../infra/gateway-boot-lifecycle.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  prepareAgentRestartRecovery,
  resumeMarkedSessions,
  persistRunningSessionsForRestart,
} from "./session-restart-resume.js";
import { prepareSessionSystemTurnAuthority } from "./session-sharing-authorization-async.js";

it.for(["current-writer", undefined] as const)(
  "logs the interrupted writer (%s), not a historical run, with the refusal notice",
  (runId) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const target = {
        agentId: "main",
        sessionKey: "agent:main:unavailable-source",
        sessionId: "unavailable-source",
      };
      replaceSessionEntrySync(target, {
        sessionId: "unavailable-source",
        updatedAt: 1,
      });
      replaceSessionEntrySync(target, {
        ...loadExactSessionEntry(target)!.entry,
        activeWriterRunId: runId,
        lastRunId: "historical-run",
        resumeAfterRestart: {
          operatorSource: { kind: "unavailable", reason: "no-auth-method" },
        },
      });
      const warn = vi.fn();
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn },
      });
      const refusal = "Error: Queued operator authority cannot be recovered; submit a new request.";
      expect(warn).toHaveBeenCalledWith(
        `Skipped restart resume for ${target.sessionKey}: ${refusal} ${JSON.stringify({
          sessionId: "unavailable-source",
          runId,
          admissionStage: "principal",
          operatorRecoveryUnavailableReason: "no-auth-method",
        })}`,
      );
      const report = await readLatestSessionTranscriptReport(target, ["run-failed-before-reply"]);
      expect(report).toMatchObject({
        ok: true,
        value: {
          content: `The Gateway restarted, but this run could not resume. ${refusal} Resolve this error, then send a new message to continue.`,
          details: { error: refusal },
        },
      });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
    }),
);

it.for(["aborted", "draining"] as const)(
  "retains restart custody while admission is %s by another restart",
  (mode, test) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:pending-resume" };
      replaceSessionEntrySync(target, {
        sessionId: "pending-resume",
        updatedAt: 110,
        lifecycleRunId: "predecessor",
        startedAt: 110,
      });
      const controller = new AbortController();
      const entered = createDeferredCore();
      const accepted = createDeferredCore<Awaited<SessionEventReceipt["accepted"]>>();
      const enqueue = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation(() => {
          entered.resolve();
          return {
            id: "pending-resume-input",
            accepted: accepted.promise,
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
            }),
            cancel: () => false,
          };
        });
      const recovery = resumeMarkedSessions({
        context: {
          ...createContext([], () => cfg),
          restartResumeWindows: { main: [{ startedAt: 100, endedAt: 200 }] },
        },
        signal: controller.signal,
        log: { warn() {} },
      });
      void recovery.catch(() => {});
      try {
        await withinTest(entered.promise, test.signal);
        const predecessor = { sourceRunId: "predecessor" };
        expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual(predecessor);
        if (mode === "aborted") {
          const error = new Error("Another restart interrupted admission");
          controller.abort(error);
          accepted.resolve({ ok: false, error: error.message, cause: error });
          await expect(recovery).rejects.toBe(error);
        } else {
          markGatewayRestartDraining();
          replaceSessionEntrySync(target, {
            ...loadExactSessionEntry(target)!.entry,
            resumeAfterRestart: {},
          });
          accepted.resolve({ ok: true });
          await recovery;
        }
        expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual(
          mode === "aborted" ? predecessor : {},
        );
        expect(enqueue).toHaveBeenCalledOnce();
      } finally {
        accepted.resolve({ ok: true });
        await Promise.allSettled([recovery]);
        resetGatewayWorkAdmission();
        enqueue.mockRestore();
      }
    }),
);

it("retains crash recovery across failed admission and a clean intermediate boot", async (test) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = (name: string) => ({ agentId: "main", sessionKey: `agent:main:${name}` });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    await beginGatewayBootLifecycle(process.env, 100);
    for (const [name, startedAt] of [
      ["predecessor", 110],
      ["older", 90],
      ["intermediate", 250],
    ] as const) {
      replaceSessionEntrySync(target(name), {
        sessionId: name,
        updatedAt: startedAt,
      });
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target(name).sessionKey,
        event: {
          runId: name,
          sessionId: name,
          ts: startedAt,
          data: { phase: "start", startedAt },
        },
      });
      expect(loadExactSessionEntry(target(name))?.entry.lifecycleRunId).toBe(name);
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    const log = { warn: vi.fn() };
    const recover = async (
      boot: Awaited<ReturnType<typeof beginGatewayBootLifecycle>>,
      mode: "failed" | "retry",
    ) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const context = Object.assign(
          createContext([], () => cfg),
          boot,
        );
        context.agentDatabaseStartup = admission.observation;
        context.resolveGatewayContext = () => context;
        const params = { context, signal: admission.signal, log };
        const opening = createDeferredCore();
        const release = createDeferredCore();
        const refusal = admission.defer({
          env: process.env,
          reason: "Synthetic deferred database preparation",
          inspections: [
            {
              target: { agentId: "main", path: database.path },
              result: Promise.resolve({ incompatible: [], indeterminate: [] }),
            },
          ],
        });
        recordAgentDatabaseAdmissions(refusal, { source: "startup" });
        const owner = admission.adopt();
        let attempts = 0;
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          publishAgent: async () => {},
          openAgent: async () => {
            attempts++;
            if (mode === "failed") {
              throw new Error("Synthetic admission failure");
            }
            if (attempts === 1) {
              throw new WorkerTaskError("worker task capacity reached", "overloaded");
            }
            opening.resolve();
            await release.promise;
          },
          migrateAgent: async ({ assertCurrent }) => ({
            recoverInputs: await prepareAgentRestartRecovery({
              ...params,
              agentId: "main",
              env: process.env,
              assertCurrent,
            }),
          }),
        });
        const preparation = admission.pendingPreparation;
        let startup: Promise<void> | undefined;
        try {
          startup = resumeMarkedSessions(params);
          if (mode === "retry") {
            await withinTest(opening.promise, test.signal);
            expect(resume).not.toHaveBeenCalled();
            expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
              "agent-database-inspection-pending",
            );
            release.resolve();
          }
          await withinTest(Promise.all([startup, preparation]), test.signal);
          await resumeMarkedSessions(params);
          expect(attempts).toBe(mode === "failed" ? 1 : 2);
        } finally {
          release.resolve();
          await owner.stop();
          await Promise.allSettled(startup ? [startup] : []);
        }
      });
    };
    try {
      // No completion for the first boot represents SIGKILL, with no shutdown markers.
      const failed = await beginGatewayBootLifecycle(process.env, 200);
      expect(failed.id).toBeDefined();
      expect(failed.restartResumeWindow).toEqual({ startedAt: 100, endedAt: 200 });
      await recover(failed, "failed");
      expect(resume).not.toHaveBeenCalled();
      expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
        "agent-database-inspection-failed",
      );
      await completeGatewayBootLifecycle(failed.id, { outcome: "clean_stop" }, process.env, 300);
      const recovered = await beginGatewayBootLifecycle(process.env, 400);
      expect(recovered.id).toBeDefined();
      expect(recovered.restartResumeWindow).toBeUndefined();
      await recover(recovered, "retry");
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        "agent:main:predecessor",
      ]);
      expect(loadExactSessionEntry(target("predecessor"))?.entry.lifecycleRunId).toBeUndefined();
      for (const name of ["older", "intermediate"]) {
        expect(loadExactSessionEntry(target(name))?.entry).toMatchObject({
          status: "killed",
          lastRunId: name,
        });
      }
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /main.*resume deferred: agent database unavailable|resume deferred: agent database unavailable.*main/u,
        ),
      );
      await completeGatewayBootLifecycle(recovered.id, { outcome: "clean_stop" }, process.env, 500);
      const next = await beginGatewayBootLifecycle(process.env, 600);
      const context = Object.assign(
        createContext([], () => cfg),
        next,
      );
      await resumeMarkedSessions({ context, signal: new AbortController().signal, log });
      expect(resume).toHaveBeenCalledOnce();
    } finally {
      resume.mockRestore();
    }
  }));

// The harness supplies a fixed tool-policy fingerprint; requester and channel authorization,
// durable shutdown markers, restoration, and event-target admission are production owners.
it.each([
  "shared-main",
  "different-owner",
  "revoked",
  "read-only",
  "own-session",
  "foreign-session",
] as const)(
  "preserves the interrupted channel requester rather than the session principal (%s)",
  (mode) =>
    withAdminIngress(async ({ admins, context, cfg, gateway }) => {
      const person = expectDefined(admins[0], "original requester");
      const other = expectDefined(admins[1], "other administrator");
      const turn = await context(person.identity.senderId);
      const original = createAdmittedRunOperatorAuthority({
        ...expectDefined(
          prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
          "authenticated channel requester",
        ),
        scopes:
          mode === "read-only"
            ? ["operator.read"]
            : mode === "own-session" || mode === "foreign-session"
              ? ["operator.sessions.write"]
              : ["operator.read", "operator.write"],
      });
      const target = { agentId: "main", sessionKey: "agent:main:main", sessionId: "shared-main" };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
        ...(mode === "shared-main"
          ? {}
          : {
              createdActor: {
                type: "human" as const,
                source: "profile" as const,
                id: mode === "own-session" ? person.profile.id : other.profile.id,
              },
            }),
      });
      // Another accepted participant must not replace the interrupted turn owner.
      const otherTurn = await context(other.identity.senderId);
      const otherAuthority = expectDefined(
        prepareInternalGetReplyOptions(undefined, otherTurn)?.operatorAuthority,
        "other participant",
      );
      await withSessionTurn(target, async (operation) => {
        const active = expectDefined(operation, "active shared-main operation");
        await active.bindToolAuthoritySnapshotAsync({
          personalToolOwner: { operatorAuthority: original },
          fingerprint: () => "restart-policy",
          fingerprintAsync: async () => "restart-policy",
          project: () => "restart-policy",
          projectAsync: async () => "restart-policy",
        });
        active.personalToolParticipants?.accept({ operatorAuthority: otherAuthority });
        await persistRunningSessionsForRestart({ cfg });
      });
      expect((await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart).toBeDefined();
      if (mode === "revoked") {
        setUserProfileRole(person.profile.id, "reader");
      }
      const resumed: Array<{ profileId?: string; scopes?: readonly string[] }> = [];
      const enqueue = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation((text, options) => {
          const input = prepareSessionEventInput(text, options);
          resumed.push({
            profileId: input.operatorAuthority?.profileId,
            scopes: input.operatorAuthority?.scopes,
          });
          return {
            id: "restored-input",
            accepted: Promise.resolve({ ok: true }),
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
            }),
            cancel: () => false,
          };
        });
      const warn = vi.fn();
      try {
        gateway.resolveGatewayContext = () => gateway;
        await resumeMarkedSessions({
          context: gateway,
          signal: new AbortController().signal,
          log: { warn },
        });
        if (mode === "revoked" || mode === "read-only" || mode === "foreign-session") {
          expect(resumed).toEqual([]);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped restart resume"));
        } else {
          expect(resumed, JSON.stringify(warn.mock.calls)).toEqual([
            {
              profileId: person.profile.id,
              scopes:
                mode === "own-session"
                  ? ["operator.sessions.write"]
                  : ["operator.read", "operator.write"],
            },
          ]);
        }
      } finally {
        enqueue.mockRestore();
      }
    }),
);

it.each([true, false])(
  "readmits the interrupted writer through current access policy (%s)",
  (allowed) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const original = { pluginId: "restart-access", grantId: "accepted-original" };
      let acceptNew = true;
      const grant = {
        grantId: "newly-admitted",
        signal: new AbortController().signal,
        assertCurrent() {},
      };
      const authorize = vi.fn(() => (acceptNew ? grant : undefined));
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(createPluginRecord({ id: original.pluginId }));
      registry.gatewayAccessPolicies.push({
        pluginId: original.pluginId,
        source: "fixture",
        policy: { authorize },
      });
      const previous = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(registry, null, "default");
      try {
        const cfg: OpenClawConfig = {
          gateway: {
            roles: {
              default: "writer",
              definitions: {
                writer: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "write" },
                  accessPolicyPlugin: original.pluginId,
                },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const person = ensureProfileForEmail("restart-grant@example.test");
        const fixture = await recoveryFixture(stateDir, person.id, {
          config: cfg,
          gatewayAccessGrant: original,
          scopes: ["operator.write"],
        });
        acceptNew = allowed;
        const effect = vi.fn();
        const restart = async () => {
          const restored = expectDefined(
            await prepareSessionSystemTurnAuthority({
              context: fixture.context,
              ...fixture.target,
              operatorSource: { kind: "gateway", snapshot: fixture.snapshot },
            }),
            "restored original requester",
          );
          try {
            expect(restored.authority.scopes).toEqual(["operator.write"]);
            effect();
          } finally {
            restored.release();
          }
        };
        if (allowed) {
          await restart();
        } else {
          await expect(restart()).rejects.toThrow();
        }
        expect(effect).toHaveBeenCalledTimes(allowed ? 1 : 0);
      } finally {
        restoreActivePluginRegistrySnapshot(previous);
      }
    }),
);

it("recovers a current owner certificate independently of the linked profile's reader role", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const principal = {
      kind: "owner" as const,
      peerKey: `iroh:${"ab".repeat(32)}`,
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1, ownerDevice: "owner-device" },
    };
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    try {
      const person = ensureProfileForEmail("restart-owner@example.test");
      setUserProfileRole(person.id, "reader");
      const fixture = await recoveryFixture(stateDir, person.id, {
        config: cfg,
        scopes: ["operator.read", "operator.write"],
        openclawIdPrincipal: principal,
      });
      const restored = expectDefined(
        await prepareSessionSystemTurnAuthority({
          context: fixture.context,
          ...fixture.target,
          operatorSource: { kind: "gateway", snapshot: fixture.snapshot },
        }),
        "restored owner certificate",
      );
      try {
        expect(restored.authority.scopes).toEqual(["operator.read", "operator.write"]);
        expect(restored.authority.profileId).toBe(person.id);
        expect(restored.authority.rolePolicy).toBeUndefined();
        setUserProfileRole(person.id, null);
        setOpenClawIdTunnelPrincipalLookup(() => undefined);
        await expect(
          prepareSessionSystemTurnAuthority({
            context: fixture.context,
            ...fixture.target,
            operatorSource: { kind: "gateway", snapshot: fixture.snapshot },
          }),
        ).rejects.toThrow();
      } finally {
        restored.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  }));
