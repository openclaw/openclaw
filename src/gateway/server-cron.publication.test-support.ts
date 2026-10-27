import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createRequireRecord } from "../../test/helpers/record.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { broadcastFor, createBroadcastPeer } from "./server-broadcast.test-support.js";
import type { AddCronJob, CronFixture } from "./server-cron.context.test-support.js";

type CronPublicationHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: CronFixture) => void | Promise<void>,
    overrides?: { broadcast: GatewayBroadcastFn },
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
