import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPersistedPluginModelCatalogs } from "../../agents/plugin-model-catalog-execution.js";
import * as catalogs from "../../agents/plugin-model-catalog.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CronService } from "../../cron/service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../cron/store.js";
import { makeStore } from "../../cron/store.test-support.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { setAvatar } from "../../state/user-profile-writes.worker.js";
import { createProfileAvatarReader } from "../../state/user-profiles-avatar.js";
import { ensureUserProfileRoleSchema } from "../../state/user-profiles-schema.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s post-ready storage consumers",
  (engine) => {
    const fixture = useMixedAgentPair(engine, engine);

    it("reads and updates operator preferences with absent and binary profile avatars", async () => {
      const profile = admit(() => {
        const owner = ensureGatewayOwnerProfile("Synthetic operator");
        ensureUserProfileRoleSchema({});
        return owner;
      });
      const preferences = { profileId: profile.id, entries: {} };
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      expect(admit(() => setAvatar(profile.id, bytes, "image/png")).ok).toBe(true);
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
      const avatar = await createProfileAvatarReader(profile.id).inspect();
      await expect(avatar.loadBytes()).resolves.toMatchObject({ bytes, mime: "image/png" });
      const set = (entries: Record<string, unknown>, expectedEntries?: Record<string, unknown>) =>
        setCanonicalUserPreferences(profile.id, entries, { expectedEntries });
      expect(await set({ accent: "blue" })).toMatchObject({ ok: true });
      expect(await set({ accent: null }, { accent: "blue" })).toMatchObject({ ok: true });
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
      expect(await set({}, { accent: null })).toMatchObject({ ok: true });
      expect(await set({ accent: "green" })).toMatchObject({ ok: true });
      expect(await set({ accent: null }, { accent: "blue" })).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual({
        profileId: profile.id,
        entries: { accent: "green" },
      });
    });

    it("reads cold placement projections and committed turn claims", async () => {
      admit(() => openOpenClawStateDatabase());
      const store = createWorkerSessionPlacementStore();
      const claimInput = {
        agentId: "main",
        sessionKey: "agent:main:placement-projection",
        sessionId: "placement-projection",
        owner: { kind: "local" as const },
        runId: "projection-run",
        claimId: "projection-claim",
      };
      const sessionId = claimInput.sessionId;
      expect((await store.readProjection([sessionId])).placements.size).toBe(0);
      const claim = await store.claimTurn(claimInput);
      try {
        expect(await store.claimTurn(claimInput)).toEqual(claim);
        const projection = await store.readProjection([sessionId], { current: true });
        expect(projection.placements.get(sessionId)).toMatchObject({
          state: "local",
          turnClaim: { claimId: "projection-claim", runId: "projection-run" },
        });
        expect([projection.environments.size, projection.pendingResults.size]).toEqual([0, 0]);
      } finally {
        await store.releaseTurn(claim);
      }
    });

    it("reads refreshed provider catalogs through the selected agent owner", async () => {
      const database = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
      const agentDir = path.dirname(database.path);
      for (const [contents, ids] of [
        ['{"marker":"first catalog"}', ["fixture", "missing"]],
        ['{"marker":"refreshed catalog"}', ["fixture"]],
      ] satisfies [string, string[]][]) {
        await catalogs.replacePersistedPluginModelCatalogs({
          agentDir,
          pluginCatalogWrites: {
            [catalogs.encodePluginModelCatalogRelativePath("fixture")]: contents,
            [catalogs.encodePluginModelCatalogRelativePath("other")]: '{"marker":"other"}',
          },
        });
        expect(await loadPersistedPluginModelCatalogs(agentDir, ids)).toEqual([
          { pluginId: "fixture", contents },
        ]);
      }
    });

    it("persists cron authority and recovery on the first authority write", async () => {
      const storePath = path.join(fixture.root, "cron", "authority.json");
      const isolated = {
        ...makeStore("captured-authority", false).jobs[0],
        sessionTarget: "isolated" as const,
        payload: { kind: "agentTurn" as const, message: "synthetic scheduled turn" },
      };
      const runtimeAuthority: CronRuntimeAuthority = {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [
          { ...isolated, runtimeAuthority: structuredClone(runtimeAuthority) },
          { ...isolated, id: "authority-recovery", runtimeAuthorityRecoveryRequired: true },
        ],
      });
      const loaded = await loadCronJobsStore(storePath);
      const find = (id: string) => loaded.jobs.find((job) => job.id === id);
      expect(find("captured-authority")).toMatchObject({ runtimeAuthority });
      expect(find("authority-recovery")).toMatchObject({ runtimeAuthorityRecoveryRequired: true });
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
      const retained = {
        name: "post-ready durable job",
        enabled: false,
        payload: { kind: "systemEvent" as const, text: "synthetic cron marker" },
      };
      try {
        await original.start();
        const job = await original.add({
          ...structuredClone(retained),
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        });
        original.stop();
        await original.waitForIdle();
        await restarted.start();
        expect(await restarted.list({ includeDisabled: true })).toMatchObject([
          { id: job.id, ...retained },
        ]);
      } finally {
        original.stop();
        restarted.stop();
        await Promise.all([original.waitForIdle(), restarted.waitForIdle()]);
      }
    });
  },
);
