import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRequireRecord } from "../../test/helpers/record.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceState } from "../cron/service/state.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { broadcastFor, createBroadcastPeer } from "./server-broadcast.test-support.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { AddCronJob, CronFixture } from "./server-cron.context.test-support.js";
import { createSessionMutationTestContext } from "./server-methods/sessions-mutations.owner.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

type CronPublicationHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: CronFixture) => void | Promise<void>,
    overrides?: {
      broadcast: GatewayBroadcastFn;
      resolveGatewayContext?: () => GatewayRequestContext | undefined;
    },
  ) => Promise<void>;
  addAgentTurnJob: AddCronJob;
  getCronDeps: (service: CronFixture) => Pick<CronServiceState["deps"], "onEvent">;
};

export function registerGatewayCronPublicationTests({
  createCronConfig,
  withCronService,
  addAgentTurnJob,
  getCronDeps,
}: CronPublicationHarness) {
  const requireRecord = createRequireRecord("object", "expected-label");

  it("broadcasts refreshed session rows when cron bindings change", async () => {
    const cfg = createCronConfig("server-cron-binding-broadcast");
    const sessionStorePath = path.join(
      os.tmpdir(),
      `server-cron-binding-broadcast-sessions-${Date.now()}`,
      "sessions.json",
    );
    (cfg.session as { store?: string }).store = sessionStorePath;
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({ "agent:main:probe": { sessionId: "sess-probe", updatedAt: Date.now() } }),
      "utf-8",
    );

    const broadcast = vi.fn();
    await withCronService(
      cfg,
      async (state) => {
        // The automation source registers on start (stale-reload safety).
        await state.cron.start();
        const sessionsChanged = () =>
          broadcast.mock.calls.filter((call) => call[0] === "sessions.changed");
        const job = await addAgentTurnJob(state, "bound schedule", "ping", {
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "session:agent:main:probe",
        });
        // Shared-process store state varies; session-utils and automation-index tests
        // own hasAutomation facts while this test pins the publication contract.
        const added = requireRecord(sessionsChanged().at(-1)?.[1], "added payload");
        expect(added.sessionKey).toBe("agent:main:probe");
        expect(added.reason).toBe("cron-binding");

        broadcast.mockClear();
        await state.cron.update(job.id, { enabled: false });
        const disabled = requireRecord(sessionsChanged().at(-1)?.[1], "disabled payload");
        expect(disabled.sessionKey).toBe("agent:main:probe");
        expect(disabled.reason).toBe("cron-binding");
      },
      { broadcast },
    );
  });

  it("delivers global binding changes only to currently authorized physical-session viewers", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = {
        ...rolePolicyConfig(),
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, ops: {}, research: {} },
        },
        session: { scope: "global" },
        cron: { enabled: false, triggers: { enabled: false } },
      };
      let context: GatewayRequestContext | undefined;
      let connection: ReturnType<typeof createGatewayConnectionState> | undefined;
      await withCronService(
        cfg,
        async (state) => {
          const recipient = (role: "none" | "view", label: string) => {
            const peer = createBroadcastPeer<Record<string, unknown>>(label, true);
            const profileClient = roleClient(role, label);
            // The profile owner's subscription must refresh the registered client itself.
            const client = Object.assign(profileClient, {
              connId: peer.client.connId,
              socket: peer.client.socket,
              usesSharedGatewayAuth: false,
              authenticatedUserProfile: {
                ...profileClient.authenticatedUserProfile!,
                avatarRevision: "test",
              },
            });
            let received = createDeferred();
            const send = peer.socket.send.getMockImplementation();
            if (!send) {
              throw new Error("Missing fixture socket transport");
            }
            peer.socket.send.mockImplementation((...args) => {
              send(...args);
              const frame = peer.frames.at(-1);
              if (frame?.event === "sessions.changed" && frame.payload?.reason === "cron-binding") {
                received.resolve();
              }
            });
            return {
              ...peer,
              client,
              next: () => received.promise,
              reset: () => {
                peer.frames.length = 0;
                received = createDeferred();
              },
            };
          };
          const opsOwner = recipient("none", "ops-owner");
          const opsReader = recipient("view", "ops-reader");
          const researchOwner = recipient("none", "research-owner");
          const peers = [opsOwner, opsReader, researchOwner];
          for (const [agentId, peer, visibility] of [
            ["ops", opsOwner, "shared"],
            ["research", researchOwner, "draft"],
          ] as const) {
            await upsertSessionEntryCore(
              { agentId, sessionKey: "global" },
              {
                sessionId: `${agentId}-global`,
                updatedAt: 1,
                visibility,
                createdActor: {
                  type: "human",
                  source: "profile",
                  id: peer.client.authenticatedUserProfile!.profileId,
                },
              },
            );
          }
          const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
          const activeConnection = createGatewayConnectionState({
            cfg,
            bootId: "cron-binding-recipients",
            scheduler: createTestGatewayScheduler(),
          });
          connection = activeConnection;
          const detach = activeConnection.attachSessionRowProjection(projection);
          peers.forEach(({ client }) => activeConnection.clients.add(client));
          context = bindSessionRowProjection(
            Object.assign(createSessionMutationTestContext(cfg), {
              resolveGatewayContext: () => context,
            }),
            activeConnection.getSessionRowProjection,
          );
          const frames = () =>
            peers.map((peer) =>
              peer.frames
                .filter(
                  (frame) =>
                    frame.event === "sessions.changed" && frame.payload?.reason === "cron-binding",
                )
                .map(({ payload }) => [payload.sessionKey, payload.agentId]),
            );
          try {
            const job = await addAgentTurnJob(state, "Global review", "Review the plan", {
              agentId: "ops",
              enabled: false,
              sessionTarget: "session:global",
              schedule: { kind: "every", everyMs: 3_600_000 },
            });
            await Promise.all([opsOwner.next(), opsReader.next()]);
            expect(frames()).toEqual([[["global", "ops"]], [["global", "ops"]], []]);
            peers.forEach((peer) => peer.reset());
            await state.cron.update(job.id, { agentId: "research" });
            await Promise.all([opsOwner.next(), researchOwner.next()]);
            expect(frames()).toEqual([
              [["global", "ops"]],
              [["global", "ops"]],
              [["global", "research"]],
            ]);
            peers.forEach((peer) => peer.reset());
            const entered = createDeferred();
            const resume = createDeferred();
            const materialize = projection.ensureMaterialized.bind(projection);
            using held = vi.spyOn(projection, "ensureMaterialized").mockImplementation(async () => {
              entered.resolve();
              await resume.promise;
              await materialize();
            });
            try {
              await state.cron.update(job.id, { agentId: "ops" });
              await entered.promise;
              expect(frames()).toEqual([[], [], []]);
              setUserProfileRole(opsReader.client.authenticatedUserProfile!.profileId, "none");
              expect(opsReader.client.preparedSessionProfile?.role).toBe("none");
              resume.resolve();
              await Promise.all([opsOwner.next(), researchOwner.next()]);
              expect(frames()).toEqual([[["global", "ops"]], [], [["global", "research"]]]);
            } finally {
              resume.resolve();
              held.mockRestore();
              await materialize();
            }
          } finally {
            context = undefined;
            detach();
            projection.dispose();
            await activeConnection.mentionInbox.dispose();
            connection = undefined;
          }
        },
        {
          broadcast: (...args) => connection?.broadcast(...args),
          resolveGatewayContext: () => context,
        },
      );
    });
  });

  it("invalidates cron readers without disclosing a retargeted job to its former audience", async () => {
    const cfg = createCronConfig("server-cron-inventory-invalidation");
    const reader = createBroadcastPeer("reader", true);
    const former = createBroadcastPeer("former", true);
    const pairing = createBroadcastPeer("pairing", true, { scopes: ["operator.pairing"] });
    const sessionOnly = createBroadcastPeer("session-only", true, {
      scopes: ["operator.sessions.read"],
    });
    const node = createBroadcastPeer("node", true, { role: "node" });
    const peers = [reader, former, pairing, sessionOnly, node];
    const oldSession = "agent:main:old-target";
    const newSession = "agent:main:new-target";
    const { broadcast } = broadcastFor(peers, {
      canReceiveSessionEvent: (client, keys) =>
        client === reader.client || keys.every((key) => key === oldSession),
    });
    const invalidations = (peer: typeof reader) =>
      peer.frames.filter((frame) => frame.event === "cron.inventory.changed");
    await withCronService(
      cfg,
      async (state) => {
        const job = await addAgentTurnJob(state, "Original automation", "private task", {
          enabled: false,
          sessionTarget: `session:${oldSession}`,
          schedule: { kind: "every", everyMs: 60_000 },
        });
        expect(invalidations(former)).toHaveLength(1);
        former.frames.length = 0;

        await state.cron.update(job.id, {
          sessionTarget: `session:${newSession}`,
          name: "Private replacement name",
        });
        expect(former.frames.filter((frame) => frame.event !== "sessions.changed")).toEqual([
          { type: "event", event: "cron.inventory.changed", seq: expect.any(Number) },
        ]);
        expect(former.frames.filter((frame) => frame.event === "sessions.changed")).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ sessionKey: oldSession, reason: "cron-binding" }),
          }),
        ]);
        const lastSequence = former.frames[0]!.seq;
        const enabledJob = await state.cron.update(job.id, { enabled: true });
        for (const action of ["started", "scheduled", "finished"] as const) {
          getCronDeps(state).onEvent?.({ jobId: job.id, action, job: enabledJob });
        }
        expect(invalidations(reader)).toHaveLength(3);
        await state.cron.update(job.id, { enabled: false });
        await state.cron.remove(job.id);
        expect(invalidations(reader)).toHaveLength(5);
        expect(invalidations(former)).toHaveLength(4);
        expect(former.frames.map(({ seq }) => seq)).toEqual(
          Array.from({ length: former.frames.length }, (_, index) => lastSequence + index),
        );
        for (const frame of invalidations(reader)) {
          expect(frame).not.toHaveProperty("payload");
        }
        for (const peer of [pairing, sessionOnly, node]) {
          expect(invalidations(peer)).toEqual([]);
          expect(peer.frames.filter((frame) => frame.event === "cron")).toEqual([]);
        }
      },
      { broadcast },
    );
  });

  it("does not invalidate inventories or bindings for unchanged runs and state-only persistence", async () => {
    const cfg = createCronConfig("server-cron-unchanged-runs");
    const broadcast = vi.fn();
    await withCronService(
      cfg,
      async (state) => {
        for (const enabled of [true, false]) {
          const job = await addAgentTurnJob(state, "Unchanged recurring job", "synthetic run", {
            agentId: "main",
            sessionKey: "agent:main:probe",
            enabled,
            schedule: { kind: "every", everyMs: 600_000 },
          });
          broadcast.mockClear();
          for (let index = 0; index < 3; index += 1) {
            await state.cron.update(job.id, { state: { streamDroppedBatches: index + 1 } });
            expect(await state.cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
            expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
          }
          expect(
            broadcast.mock.calls.filter(([event]) => event === "cron.inventory.changed"),
          ).toEqual([]);
          expect(
            broadcast.mock.calls.filter(
              ([event, payload]) =>
                event === "sessions.changed" && payload?.reason === "cron-binding",
            ),
          ).toEqual([]);
        }
      },
      { broadcast },
    );
  });

  it("publishes an enabled flip committed by a one-shot run", async () => {
    const broadcast = vi.fn();
    await withCronService(
      createCronConfig("server-cron-run-disable"),
      async (state) => {
        const job = await addAgentTurnJob(state, "One-shot job", "synthetic run", {
          agentId: "main",
          sessionKey: "agent:main:probe",
          deleteAfterRun: false,
        });
        broadcast.mockClear();
        expect(await state.cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        expect(
          broadcast.mock.calls.filter(([event]) => event === "cron.inventory.changed"),
        ).toHaveLength(1);
        const bindingEvents = broadcast.mock.calls.filter(
          ([event, payload]) => event === "sessions.changed" && payload?.reason === "cron-binding",
        );
        expect(bindingEvents).toHaveLength(2);
        expect(
          bindingEvents.map(
            ([, payload]) => requireRecord(payload, "run binding payload").sessionKey,
          ),
        ).toEqual(expect.arrayContaining([`agent:main:cron:${job.id}`, "agent:main:probe"]));
      },
      { broadcast },
    );
  });
}
