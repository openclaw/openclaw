import { expect, it, vi } from "vitest";
import type {
  CronOwnerProjection as Projection,
  LegacyCronRepairState as State,
} from "../commands/doctor/cron/legacy-repair.js";
import {
  isCronOwnerWriteRefusalError,
  prepareCronOwnerWriteRefusal,
} from "./io.cron-owner-refusal.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const state = (
  rawJobs: Array<Record<string, unknown>>,
  invalidConfigRows: Array<Record<string, unknown>> = [],
  projectedOwnersByJobId: ReadonlyMap<string, Projection> = new Map(),
) => ({ rawJobs, invalidConfigRows, projectedOwnersByJobId, ownerRows: [] }) as unknown as State;
const deps = (
  activeGateway?: {
    pid: number;
    port: number;
    cronOwnerProjection?: "dynamic-default-v1";
  },
  cronState: State | null = null,
) => ({
  readActiveGatewayLockIdentity: vi.fn(async () =>
    activeGateway ? { ...activeGateway, createdAt: new Date(0).toISOString() } : undefined,
  ),
  loadLegacyCronRepairState: vi.fn(async () => cronState),
});
const cfg = { agents: { entries: { ops: {} } } };
const prepare = (
  injected: ReturnType<typeof deps>,
  provenOwnerAgentId?: string,
  storePath = "/tmp/cron.json",
) => prepareCronOwnerWriteRefusal(cfg, { storePath, provenOwnerAgentId }, injected);
const activeGateway = {
  pid: process.pid + 1,
  port: 18_789,
  cronOwnerProjection: "dynamic-default-v1" as const,
};

it("allows an ownership-safe live Gateway with a projected dynamic row and rechecks at commit", async () => {
  const injected = deps(
    activeGateway,
    state(
      [{ id: "dynamic" }],
      [],
      new Map([["dynamic", { kind: "runtime-default" as const, agentId: "ops" }]]),
    ),
  );
  const plan = await prepare(injected);
  injected.loadLegacyCronRepairState.mockResolvedValueOnce(state([{ id: "ownerless" }]));
  await expect(plan.recheck()).rejects.toThrow("ownerless legacy cron job");
});

it("refuses an unproven live Gateway without suggesting doctor", async () => {
  const refusal = prepare(deps({ pid: process.pid + 1, port: 18_789 }));
  await expect(refusal).rejects.toThrow("live external Gateway");
  await expect(refusal).rejects.not.toThrow("doctor --fix");
});

it("refuses ownerless and corrupt cron rows with an ownership-safe live Gateway", async () => {
  const ownerless = state([
    { id: "null", agentId: null },
    { id: "blank", agentId: " " },
  ]);
  await expect(prepare(deps(activeGateway, ownerless))).rejects.toThrow(
    "contains 2 ownerless legacy cron job",
  );
  const corrupt = state([], [{ id: "corrupt", reason: "invalid config" }]);
  await expect(prepare(deps(activeGateway, corrupt))).rejects.toThrow("contains 1 corrupt row");
});

it("keeps include-owned binding writes fail closed", () => {
  expect(() =>
    assertAutomaticBindingsWriteAllowed({
      bindingsIncludeOwned: true,
      ownershipPaths: [["bindings"]],
    }),
  ).toThrow("cannot append to $include-owned bindings");
});

it("refuses a retained historical owner even when the runtime projects a new default", async () => {
  const owned = { id: "owned", agentId: "research" };
  const injected = deps(
    undefined,
    state(
      [{ id: "ownerless" }, owned],
      [],
      new Map([
        ["ownerless", { kind: "runtime-default" as const, agentId: "research" }],
        ["owned", { kind: "explicit" as const, agentId: "research" }],
      ]),
    ),
  );
  const refusal = prepare(injected, "ops");
  await expect(refusal).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  await expect(refusal).rejects.toThrow("openclaw doctor --fix");

  injected.loadLegacyCronRepairState.mockResolvedValue(
    state([{ id: "ownerless", agentId: "ops" }, owned]),
  );
  const permitted = await prepare(injected, "ops");
  await permitted.recheck();
});

it("keeps ambiguous and unreadable ownership as typed refusals", async () => {
  const ambiguous = deps(undefined, state([{ id: "ownerless" }]));
  await expect(prepare(ambiguous)).rejects.toSatisfy(isCronOwnerWriteRefusalError);

  const corrupt = deps();
  const error = new Error("database disk image is malformed");
  corrupt.loadLegacyCronRepairState.mockRejectedValueOnce(error);
  const unreadable = prepare(corrupt, "ops", "/tmp/corrupt-cron.json");
  await expect(unreadable).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  await expect(unreadable).rejects.toThrow(error.message);
});
