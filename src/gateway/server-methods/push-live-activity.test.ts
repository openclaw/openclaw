import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { emitAgentEventForOwner } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as apns from "../../infra/push-apns.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { userProfilesDb } from "../../state/user-profiles-internal.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import {
  ACTIVITY_EPOCH,
  activityAuth,
  activityDirect,
  withLiveActivityFixture,
} from "../live-activity.test-support.js";

it("prepares only observed facts for the exact prepared public run without creating activity state", async () => {
  await withLiveActivityFixture(async (f) => {
    const request = {
      key: f.session.sessionKey,
      agentId: "main",
      sessionId: f.entry.sessionId,
      publicRunId: f.publicRunId,
    };
    expect((await f.rpc("push.liveActivity.prepare", request))[0]).toBe(false);
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const prepared = await f.prepare();
    expect(prepared.binding.publicRunId).toBe(f.publicRunId);
    expect(prepared.snapshot).toMatchObject({
      status: "running",
      observedAtMs: ACTIVITY_EPOCH,
      startedAtMs: ACTIVITY_EPOCH,
    });
    expect(
      (
        await f.rpc("push.liveActivity.prepare", {
          ...request,
          publicRunId: f.internalRunId,
        })
      )[0],
    ).toBe(false);
    f.entry.preparedSession = undefined;
    expect((await f.rpc("push.liveActivity.prepare", request))[0]).toBe(false);
    expect(tableExists(openOpenClawStateDatabase().db, "apns_live_activities")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each([
  "profile",
  "pairing",
  "role",
  "connection",
  "replacement connection",
  "terminal",
  "incarnation",
] as const)("rejects registration when %s changes during transport preparation", async (change) => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const prepared = await f.prepare();
    const entered = createDeferred();
    const auth = createDeferred<Awaited<ReturnType<typeof apns.resolveApnsAuthConfigFromEnv>>>();
    vi.spyOn(apns, "resolveApnsAuthConfigFromEnv").mockImplementation(() => {
      entered.resolve();
      return auth.promise;
    });
    const pending = f.rpc("push.liveActivity.register", {
      activityId: "raced",
      expected: { binding: prepared.binding, sourceIncarnation: prepared.sourceIncarnation },
      destination: activityDirect,
    });
    await entered.promise;
    let successor: string | undefined;
    try {
      if (change === "profile") {
        f.client.authenticatedUserProfile!.profileId = "changed-profile";
      } else if (change === "pairing") {
        f.device.nodeSurface!.approvedAtMs++;
        f.pair();
      } else if (change === "role") {
        setUserProfileRole(f.profile.id, "reader");
      } else if (change === "connection") {
        f.disconnect();
      } else if (change === "replacement connection") {
        f.replaceConnection();
      } else if (change === "terminal") {
        await f.emit("lifecycle", { phase: "end", endedAt: ACTIVITY_EPOCH });
      } else {
        releaseAgentRunContext(f.internalRunId, f.claimId);
        successor = claimAgentRunContext(
          f.internalRunId,
          {
            ...f.session,
            sessionId: f.entry.sessionId,
          },
          { exclusive: true, trackOwner: true },
        );
        if (!successor) {
          throw new Error("Fixture requires a successor producer claim");
        }
        emitAgentEventForOwner(
          {
            runId: f.internalRunId,
            stream: "tool",
            data: { phase: "start" },
          },
          successor,
        );
      }
      auth.resolve({ ok: true, value: activityAuth });
      expect((await pending)[0]).toBe(false);
      expect(f.coordinator.store.list(f.coordinator.gatewayId)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      auth.resolve({ ok: true, value: activityAuth });
      await pending;
      if (successor) {
        releaseAgentRunContext(f.internalRunId, successor);
      }
    }
  });
});

it.each(["role", "profile merge", "pairing", "operator token"] as const)(
  "rereads %s inside the store transaction, not a committed-only separate connection",
  async (change) => {
    await withLiveActivityFixture(async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const prepared = await f.prepare();
      const merged =
        change === "profile merge"
          ? ensureProfileForEmail("activity-successor@example.test")
          : undefined;
      if (merged) {
        setUserProfileRole(merged.id, "writer");
      }
      vi.spyOn(apns, "resolveApnsAuthConfigFromEnv").mockResolvedValue({
        ok: true,
        value: activityAuth,
      });
      const register = f.coordinator.store.register.bind(f.coordinator.store);
      vi.spyOn(f.coordinator.store, "register").mockImplementation((input, isCurrent) =>
        register(input, (binding, incarnation, db) => {
          if (change === "role" || change === "profile merge") {
            executeSqliteQuerySync(
              db,
              userProfilesDb(db)
                .updateTable("user_profiles")
                .set(merged ? { merged_into: merged.id } : { role: "reader" })
                .where("id", "=", f.profile.id),
            );
          } else {
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .updateTable("device_pairing_paired")
                .set(
                  change === "pairing"
                    ? {
                        node_surface_json: JSON.stringify({
                          ...f.device.nodeSurface,
                          approvedAtMs: f.device.nodeSurface!.approvedAtMs + 1,
                        }),
                      }
                    : {
                        tokens_json: JSON.stringify({
                          ...f.device.tokens,
                          operator: { ...f.device.tokens!.operator, revokedAtMs: Date.now() },
                        }),
                      },
                )
                .where("device_id", "=", f.device.deviceId),
            );
          }
          return isCurrent(binding, incarnation, db);
        }),
      );
      const response = await f.rpc("push.liveActivity.register", {
        activityId: "transaction-race",
        expected: { binding: prepared.binding, sourceIncarnation: prepared.sourceIncarnation },
        destination: activityDirect,
      });
      expect(response[0]).toBe(false);
      expect(f.coordinator.store.list(f.coordinator.gatewayId)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  },
);

it("discovers a terminal tombstone after public-run cleanup without credentials or a cached registration", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(1_000);
    await f.emit("lifecycle", { phase: "end", endedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    f.chatAbortControllers.clear();
    const db = openOpenClawStateDatabase().db;
    const before = db.prepare("SELECT total_changes() AS count").get();
    for (let retry = 0; retry < 2; retry++) {
      const response = await f.rpc("push.liveActivity.discover", {
        activityId: registered.activityId,
        selectors: f.selectors,
      });
      expect(response).toEqual([
        true,
        {
          status: "found",
          registration: { ...registered, state: "tombstone" },
        },
      ]);
    }
    expect(
      (
        await f.rpc("push.liveActivity.register", {
          activityId: registered.activityId,
          expected: {
            binding: registered.binding,
            sourceIncarnation: registered.sourceIncarnation,
          },
          destination: activityDirect,
        })
      )[1],
    ).toEqual({ ...registered, state: "tombstone" });
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
});

it("revokes an owned registration after live-run cleanup without renewing its lease", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);
    f.chatAbortControllers.clear();
    expect(
      (
        await f.rpc("push.liveActivity.revoke", {
          registrationId: registered.registrationId,
          expectedRevision: registered.rotationRevision,
        })
      )[1],
    ).toEqual({ removed: true });
    expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
      state: "tombstone",
      leaseExpiresAtMs: registered.leaseExpiresAtMs,
    });
    vi.setSystemTime(ACTIVITY_EPOCH + 24 * 3_600_000);
    const db = openOpenClawStateDatabase().db;
    const before = db.prepare("SELECT total_changes() AS count").get();
    expect(
      (
        await f.rpc("push.liveActivity.discover", {
          activityId: registered.activityId,
          selectors: f.selectors,
        })
      )[1],
    ).toEqual({ status: "unknown" });
    expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
});

it("keeps discovery read-only, including missing tables and unswept expiry", async () => {
  await withLiveActivityFixture(async (f) => {
    const db = openOpenClawStateDatabase().db;
    const initial = db.prepare("SELECT total_changes() AS count").get();
    expect(
      (
        await f.rpc("push.liveActivity.discover", {
          activityId: "absent",
          selectors: f.selectors,
        })
      )[1],
    ).toEqual({ status: "unknown" });
    expect(tableExists(db, "apns_live_activities")).toBe(false);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(initial);

    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(registered.leaseExpiresAtMs);
    const before = db.prepare("SELECT total_changes() AS count").get();
    const response = await f.rpc("push.liveActivity.discover", {
      activityId: registered.activityId,
      selectors: f.selectors,
    });
    expect(response[1]).toMatchObject({ status: "found", registration: { state: "tombstone" } });
    expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("active");
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
});

it("checks every server selector and permits read scope only for discovery", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    setUserProfileRole(f.profile.id, "reader");
    f.client.connect.scopes = ["operator.read"];
    for (const field of Object.keys(f.selectors)) {
      expect(
        (
          await f.rpc("push.liveActivity.discover", {
            activityId: registered.activityId,
            selectors: { ...f.selectors, [field]: "different" },
          })
        )[0],
      ).toBe(false);
    }
    expect(
      (
        await f.rpc("push.liveActivity.discover", {
          activityId: registered.activityId,
          selectors: { ...f.selectors, gatewayId: "local-route" },
        })
      )[0],
    ).toBe(false);
    expect(
      (
        await f.rpc("push.liveActivity.discover", {
          activityId: registered.activityId,
          selectors: f.selectors,
        })
      )[0],
    ).toBe(true);
    expect(
      (
        await f.rpc("push.liveActivity.revoke", {
          registrationId: registered.registrationId,
          expectedRevision: registered.rotationRevision,
        })
      )[0],
    ).toBe(false);
  });
});

it.each(["incognito", "same-SID reset"] as const)(
  "rejects discovery for %s even with operator.admin",
  async (change) => {
    await withLiveActivityFixture(async (f) => {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const registered = await f.register();
      await upsertSessionEntryCore(f.session, {
        sessionId: f.entry.sessionId,
        updatedAt: Date.now(),
        ...(change === "incognito" ? { incognito: true } : { lifecycleRevision: "reset-revision" }),
      });
      expect(
        (
          await f.rpc("push.liveActivity.discover", {
            activityId: registered.activityId,
            selectors: f.selectors,
          })
        )[0],
      ).toBe(false);
    });
  },
);
