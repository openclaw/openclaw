import { expect, it, vi } from "vitest";
import { resolveCronListSnapshotRevision } from "../../cron/list-snapshot-revision.js";
import type { CronJob } from "../../cron/types.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { cronListHandler } from "./cron-list.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

it("reuses immutable list projections and encoded rows until the owner or default agent changes", async () => {
  let job = freezeJsonSnapshot<CronJob>({
    id: "snapshot-job",
    name: "snapshot job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 1_000, anchorMs: 1 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "synthetic job" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: 100 },
  });
  let defaultAgentId = "main";
  const config = {};
  const context = {
    cron: {
      getDefaultAgentId: () => defaultAgentId,
      getJob: () => job,
      listPage: async () => ({
        jobs: [job],
        snapshotRevision: resolveCronListSnapshotRevision([job]),
        total: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
        nextOffset: null,
      }),
    },
    getRuntimeConfig: () => config,
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
  const read = async (compact: boolean) => {
    const params = { compact, includeDeliveryPreviews: false };
    const respond = vi.fn<RespondFn>();
    await cronListHandler({
      req: { type: "req", id: "snapshot", method: "cron.list", params },
      params,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const payload = respond.mock.calls[0]![1] as { jobs: Array<Record<string, unknown>> };
    const frame = serializeGatewayFrame({ type: "res", id: "snapshot", ok: true, payload });
    return { row: payload.jobs[0]!, wire: JSON.parse(frame.toString()).payload.jobs[0] };
  };
  const full = await read(false);
  const compact = await read(true);
  expect((await read(false)).row).toBe(full.row);
  expect((await read(true)).row).toBe(compact.row);
  expect(Object.isFrozen(full.row)).toBe(true);
  expect(Object.isFrozen(compact.row)).toBe(true);
  expect(full.wire).toMatchObject({ effectiveAgentId: "main", nextRunAtMs: 100 });
  expect(compact.wire).toMatchObject({ effectiveAgentId: "main", nextRunAtMs: 100 });

  defaultAgentId = "ops";
  const retargeted = await read(false);
  expect(retargeted.row).not.toBe(full.row);
  expect(retargeted.wire.effectiveAgentId).toBe("ops");
  job = freezeJsonSnapshot({ ...job, state: { nextRunAtMs: 200 } });
  const updated = await read(false);
  expect(updated.row).not.toBe(retargeted.row);
  expect(updated.wire).toMatchObject({ effectiveAgentId: "ops", nextRunAtMs: 200 });
  expect((await read(true)).wire.nextRunAtMs).toBe(200);
  expect(full.wire.nextRunAtMs).toBe(100);
});
