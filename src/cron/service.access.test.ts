import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { cronJobReadView } from "./job-read-view.js";
import { normalizeCronJobCreate } from "./normalize.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import { stripJobRuntimeFields } from "./store/job-config-codec.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-access-" });
const input = () =>
  normalizeCronJobCreate({
    name: "Scheduled review",
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Review" },
    delivery: { mode: "none" },
  })!;

it("round-trips Access changes beside an existing job without rewriting its selection", async () => {
  await withCronServiceForTest(
    {
      makeStorePath,
      scheduler: createTestGatewayScheduler(),
      logger: createNoopLogger(),
      cronEnabled: false,
    },
    async ({ cron, state }) => {
      const legacy = await cron.add(input());
      const before = (await loadCronStore(state.deps.storePath)).jobs.find(
        (row) => row.id === legacy.id,
      );
      const job = await cron.add({ ...input(), cyberAccessProgram: "standard" });
      expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
      expect(await cron.run(job.id, "force")).toEqual({ ok: true, ran: true });
      const encoded = stripJobRuntimeFields(cron.getJob(job.id)!);
      expect(encoded.payload).toMatchObject({ kind: "accessAgentTurn", message: "Review" });
      expect(getInvalidPersistedCronJobReason(encoded)).toBeNull();
      expect(getInvalidPersistedCronJobReason({ ...encoded, cyberAccessProgram: undefined })).toBe(
        "invalid-execution-policy",
      );
      expect(stripJobRuntimeFields(legacy).payload).toMatchObject({ kind: "agentTurn" });
      expect(cron.getJob(job.id)?.cyberAccessProgram).toBe("standard");
      const reload = async () => {
        const row = (await loadCronStore(state.deps.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        assert(row);
        return cronJobReadView(row);
      };
      expect((await reload()).cyberAccessProgram).toBe("standard");
      await cron.update(job.id, { name: "Renamed" });
      expect((await reload()).cyberAccessProgram).toBe("standard");
      for (const cyberAccessProgram of ["daybreak_blue", "daybreak_red"] as const) {
        await cron.update(job.id, { cyberAccessProgram });
        expect((await reload()).cyberAccessProgram).toBe(cyberAccessProgram);
      }
      await cron.update(job.id, { cyberAccessProgram: null });
      expect(await reload()).not.toHaveProperty("cyberAccessProgram");
      expect(stripJobRuntimeFields(cron.getJob(job.id)!).payload).toMatchObject({
        kind: "agentTurn",
      });
      expect(
        (await loadCronStore(state.deps.storePath)).jobs.find((row) => row.id === legacy.id),
      ).toEqual(before);
      await cron.remove(job.id);
      expect((await loadCronStore(state.deps.storePath)).jobs.map((row) => row.id)).toEqual([
        legacy.id,
      ]);
    },
  );
});

it("rejects invalid Access at the public mutation boundary and permits clearing", () => {
  expect(validateCronAddParams({ ...input(), cyberAccessProgram: "invalid" })).toBe(false);
  expect(validateCronUpdateParams({ id: "job", patch: { cyberAccessProgram: "invalid" } })).toBe(
    false,
  );
  expect(validateCronUpdateParams({ id: "job", patch: { cyberAccessProgram: null } })).toBe(true);
});
