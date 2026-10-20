import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersistedPluginModelCatalogs } from "../../agents/plugin-model-catalog-execution.js";
import {
  encodePluginModelCatalogRelativePath,
  replacePersistedPluginModelCatalogs,
} from "../../agents/plugin-model-catalog.js";
import { CronService } from "../../cron/service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../cron/store.js";
import { makeStore } from "../../cron/store.test-support.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getCanonicalUserPreferences } from "../../state/user-preferences.js";
import { setAvatar } from "../../state/user-profile-writes.worker.js";
import { createProfileAvatarReader } from "../../state/user-profiles-avatar.js";
import { ensureUserProfileRoleSchema } from "../../state/user-profiles-schema.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s post-ready storage consumers",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("reads operator preferences with absent and binary profile avatars", async () => {
      const profile = withEngineStoreAdmission(() => {
        const owner = ensureGatewayOwnerProfile("Synthetic operator");
        ensureUserProfileRoleSchema({});
        return owner;
      });
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual({
        profileId: profile.id,
        entries: {},
      });
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      expect(withEngineStoreAdmission(() => setAvatar(profile.id, bytes, "image/png")).ok).toBe(
        true,
      );
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual({
        profileId: profile.id,
        entries: {},
      });
      const avatar = await createProfileAvatarReader(profile.id).inspect();
      await expect(avatar.loadBytes()).resolves.toMatchObject({ bytes, mime: "image/png" });
    });

    it("reads cold placement projections and committed turn claims", async () => {
      withEngineStoreAdmission(() => openOpenClawStateDatabase());
      const store = createWorkerSessionPlacementStore();
      const session = {
        agentId: "main",
        sessionKey: "agent:main:placement-projection",
        sessionId: "placement-projection",
      };
      expect((await store.readProjection([session.sessionId])).placements.size).toBe(0);
      const claimInput = {
        ...session,
        owner: { kind: "local" as const },
        runId: "projection-run",
        claimId: "projection-claim",
      };
      const claim = await store.claimTurn(claimInput);
      try {
        expect(await store.claimTurn(claimInput)).toEqual(claim);
        const projection = await store.readProjection([session.sessionId], { current: true });
        expect(projection.placements.get(session.sessionId)).toMatchObject({
          state: "local",
          turnClaim: { claimId: "projection-claim", runId: "projection-run" },
        });
        expect(projection.environments.size).toBe(0);
        expect(projection.pendingResults.size).toBe(0);
      } finally {
        await store.releaseTurn(claim);
      }
    });

    it("reads refreshed provider catalogs through the selected agent owner", async () => {
      const database = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      const agentDir = path.dirname(database.path);
      const write = (contents: string) =>
        replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: {
            [encodePluginModelCatalogRelativePath("fixture")]: contents,
            [encodePluginModelCatalogRelativePath("other")]: '{"marker":"other"}',
          },
        });
      const first = '{"marker":"first catalog"}';
      const refreshed = '{"marker":"refreshed catalog"}';
      await write(first);
      expect(await loadPersistedPluginModelCatalogs(agentDir, ["fixture", "missing"])).toEqual([
        { pluginId: "fixture", contents: first },
      ]);
      await write(refreshed);
      expect(await loadPersistedPluginModelCatalogs(agentDir, ["fixture"])).toEqual([
        { pluginId: "fixture", contents: refreshed },
      ]);
    });

    it("persists cron authority and recovery on the first authority write", async () => {
      const storePath = path.join(fixture.root, "cron", "authority.json");
      const captured = makeStore("captured-authority", false);
      captured.jobs[0].sessionTarget = "isolated";
      captured.jobs[0].payload = { kind: "agentTurn", message: "synthetic scheduled turn" };
      captured.jobs[0].runtimeAuthority = {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      const recovery = makeStore("authority-recovery", false);
      recovery.jobs[0].sessionTarget = "isolated";
      recovery.jobs[0].payload = { kind: "agentTurn", message: "synthetic recovery turn" };
      recovery.jobs[0].runtimeAuthorityRecoveryRequired = true;
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [...captured.jobs, ...recovery.jobs],
      });
      const loaded = await loadCronJobsStore(storePath);
      expect(loaded.jobs.find((job) => job.id === "captured-authority")).toMatchObject({
        runtimeAuthority: {
          version: 1,
          runtimeId: "codex",
          namespace: "codex.apps",
          payload: { apps: [{ id: "calendar" }] },
        },
      });
      expect(loaded.jobs.find((job) => job.id === "authority-recovery")).toMatchObject({
        runtimeAuthorityRecoveryRequired: true,
      });
    });

    it("starts cron and retains a disabled job across scheduler restart", async () => {
      const unexpectedDispatch = () => {
        throw new Error("Disabled cron conformance job must not dispatch");
      };
      const createCron = () =>
        new CronService({
          scheduler: createTestGatewayScheduler(),
          storePath: path.join(fixture.root, "cron", "post-ready.json"),
          cronEnabled: false,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          enqueueSystemEvent: unexpectedDispatch,
          requestHeartbeat: unexpectedDispatch,
          runIsolatedAgentJob: unexpectedDispatch,
        });
      const original = createCron();
      const restarted = createCron();
      try {
        await original.start();
        const job = await original.add({
          name: "post-ready durable job",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "synthetic cron marker" },
        });
        original.stop();
        await original.waitForIdle();
        await restarted.start();
        expect(await restarted.list({ includeDisabled: true })).toMatchObject([
          {
            id: job.id,
            name: "post-ready durable job",
            enabled: false,
            payload: { kind: "systemEvent", text: "synthetic cron marker" },
          },
        ]);
      } finally {
        original.stop();
        restarted.stop();
        await Promise.all([original.waitForIdle(), restarted.waitForIdle()]);
      }
    });
  },
);
