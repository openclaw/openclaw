import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { readSessionQueuedInputPage } from "../../config/sessions/session-pending-input-history.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { CronService } from "../../cron/service.js";
import { resolveCronOperatorExecutionRevision } from "../../cron/service/jobs-tool-policy.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../cron/store.js";
import type { CronStoredJob } from "../../cron/types.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { prepareUserProfileRoleAuthority } from "../../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { runCronCommandUnderSource } from "../cron-command-source.js";
import type { OperatorRunRecoverySnapshot } from "../operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "../operator-run-recovery.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { canonicalMemberProfiles } from "./member-profiles.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalLookup(undefined);
  setOpenClawIdMemberAccountLookup(undefined);
});

it("imports null-assigned saved member work and admits it under current policy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId: "legacy" });
    const policy: GatewayOperatorRoleDefinition = {
      agents: ["main"],
      scopes: ["operator.write"],
      sessions: { others: "none" as const },
    };
    const config: OpenClawConfig = {
      gateway: { openclawId: { enabled: true }, roles: { definitions: { operator: policy } } },
    };
    setRuntimeConfigSnapshot(config);
    const principal = {
      kind: "member",
      accountId: "legacy",
      role: "operator",
      peerKey: `iroh:${"ac".repeat(32)}`,
      authority: { clawId: "legacy-claw", rootPub: "legacy-root", listedSeq: 1 },
    } satisfies OpenClawIdTunnelPrincipal;
    setOpenClawIdMemberAccountLookup((accountId) => accountId === principal.accountId);
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    // Shipped membership authority recorded a null profile assignment alongside this policy.
    const snapshot: OperatorRunRecoverySnapshot = {
      profileId: profile.id,
      assignedRole: null,
      githubLogin: null,
      scopes: ["operator.write"],
      rolePolicy: policy,
      openclawIdPrincipal: principal,
      grant: null,
      aliasBindingIds: [],
      authPolicy: {
        generation: "",
        role: "operator",
        authMethod: "trusted-proxy",
        grantGeneration: captureGatewayAuthPolicy(config, {
          role: "operator",
          authMethod: "trusted-proxy",
        }).grantGeneration,
      },
      controlUiAdmin: false,
      localOperator: false,
      sourceIngress: "control-ui",
    };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:upgrade",
      sessionId: "upgrade",
      storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
    };
    const source = { kind: "gateway" as const, snapshot };
    const entrySeed = {
      sessionId: target.sessionId,
      updatedAt: 1,
      lifecycleRevision: "legacy-generation",
      createdActor: { type: "human" as const, source: "profile" as const, id: profile.id },
    };
    await replaceSessionEntry(target, entrySeed);
    await replaceSessionEntry(target, {
      ...entrySeed,
      operatorSources: { [profile.id]: snapshot },
      resumeAfterRestart: { operatorSource: source },
    });
    const legacyEntry = expectDefined(
      await readSessionEntryReadOnlyInWorker(target),
      "saved source",
    );
    expect(legacyEntry.operatorSources?.[profile.id]).toEqual(snapshot);
    expect(legacyEntry.resumeAfterRestart?.operatorSource).toEqual(source);
    const hiddenTarget = {
      ...target,
      sessionKey: "agent:main:internal-session-effects:legacy",
      sessionId: "hidden",
    };
    await replaceSessionEntry(hiddenTarget, { sessionId: "hidden", updatedAt: 1 });
    const hiddenEntry = await readSessionEntryReadOnlyInWorker(hiddenTarget);
    const receipt = expectDefined(
      await stageSessionPendingInput(target, {
        runId: "legacy-queued",
        message: {
          role: "user",
          content: "saved input",
          timestamp: 1,
          idempotencyKey: "legacy-queued:user",
        },
        recoverySource: source,
        assertCurrent() {},
      }),
      "persisted queued input",
    );
    receipt.relinquish();
    await receipt.settled?.();
    const storePath = path.join(stateDir, "cron/jobs.json");
    const ran = path.join(stateDir, "upgrade-ran");
    const jobs = ["matching", "mismatched"].map<CronStoredJob>((id) => {
      const job: CronStoredJob = makeCronJob({
        id,
        agentId: "main",
        payload: {
          kind: "command",
          argv: [
            process.execPath,
            "-e",
            `require('node:fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(id)})`,
          ],
        },
      });
      job.operatorSource = {
        executionRevision: resolveCronOperatorExecutionRevision(job),
        source: {
          version: 1,
          kind: "gateway",
          agentId: "main",
          sourceRunId: "legacy-run",
          snapshot:
            id === "matching"
              ? snapshot
              : { ...snapshot, rolePolicy: { ...policy, agents: ["other"] } },
        },
      };
      return job;
    });
    await saveCronJobsStore(storePath, { version: 1, jobs });
    expect((await prepareUserProfileRoleAuthority(profile.id))?.role).toBeNull();
    const context = createContext();
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    let cron: CronService | undefined;
    try {
      await canonicalMemberProfiles.setRole("legacy", "operator", true);
      await closeOpenClawStateDatabaseAsync();
      expect((await prepareUserProfileRoleAuthority(profile.id))?.role).toBe("operator");
      expect(await readSessionEntryReadOnlyInWorker(hiddenTarget)).toEqual(hiddenEntry);
      const migrated = { ...snapshot, assignedRole: "operator" };
      const stored = await loadCronJobsStore(storePath);
      expect(
        stored.jobs.find((job) => job.id === "matching")?.operatorSource?.source.snapshot,
      ).toEqual(migrated);
      expect(stored.jobs.find((job) => job.id === "mismatched")?.operatorSource).toEqual(
        jobs[1]!.operatorSource,
      );
      const entry = expectDefined(
        await readSessionEntryReadOnlyInWorker(target),
        "retained session",
      );
      const pending = expectDefined(
        (await readSessionQueuedInputPage(target)).rows[0],
        "retained queued input",
      );
      const queued = JSON.parse(
        expectDefined(pending.origin_source_json, "stored queued authority"),
      );
      expect(entry.operatorSources?.[profile.id]).toEqual(migrated);
      expect(entry.resumeAfterRestart?.operatorSource).toEqual({
        kind: "gateway",
        snapshot: migrated,
      });
      expect(queued).toEqual({ kind: "gateway", snapshot: migrated });
      for (const recovered of [entry.resumeAfterRestart!.operatorSource, queued]) {
        const restored = await restoreGatewayQueuedOperatorRecovery({
          source: recovered,
          context,
          assertCurrent() {},
        });
        try {
          expect(restored.authority.profileId).toBe(profile.id);
          expect(restored.authority.scopes).toEqual(["operator.write"]);
        } finally {
          restored.release();
        }
      }
      cron = new CronService({
        storePath,
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent() {},
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        runCommandJob: (params) => runCronCommandUnderSource(params, () => context),
      });
      context.cron = cron;
      await cron.run("matching", "force");
      expect(cron.getJob("matching")?.state.lastRunStatus).toBe("ok");
      expect(fs.readFileSync(ran, "utf8")).toBe("matching");
      await cron.run("mismatched", "force");
      expect(cron.getJob("mismatched")?.state.lastRunStatus).toBe("ok");
      expect(fs.readFileSync(ran, "utf8")).toBe("matchingmismatched");
      await canonicalMemberProfiles.setRole("legacy", "operator", true);
      expect(
        (await loadCronJobsStore(storePath)).jobs.find((job) => job.id === "mismatched")
          ?.operatorSource,
      ).toEqual(jobs[1]!.operatorSource);
    } finally {
      cron?.stop();
    }
  });
});
