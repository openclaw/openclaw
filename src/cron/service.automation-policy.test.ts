import { expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { cronJobReadView } from "./job-read-view.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";
import { loadCronStore } from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-automation-policy-" });
const prompt = " \tReview the checklist.\r\n  Keep authored spacing.\n ";

it("persists and edits ordinary automation policy through the public Cron boundary", async () => {
  await withCronServiceForTest(
    {
      makeStorePath,
      scheduler: createTestGatewayScheduler(),
      logger: createNoopLogger(),
      cronEnabled: false,
    },
    async ({ cron, state }) => {
      const input = normalizeCronJobCreate({
        name: "Owner check",
        agentId: "helper",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "now",
        activeHours: { start: "22:00", end: "07:00", timezone: "UTC" },
        idleOnly: true,
        payload: {
          kind: "agentTurn",
          message: prompt,
          skipIfScratchEmpty: true,
          includeReasoning: true,
        },
        delivery: { mode: "announce", target: "owner", directPolicy: "block" },
      });
      expect(validateCronAddParams(input)).toBe(true);
      if (!input) {
        throw new Error("expected normalized automation input");
      }
      const job = await cron.add(input);
      const reload = async () => {
        const stored = (await loadCronStore(state.deps.storePath)).jobs.find(
          (row) => row.id === job.id,
        );
        if (!stored) {
          throw new Error("expected persisted automation");
        }
        return cronJobReadView(stored);
      };
      const first = await reload();
      expect(first).toMatchObject({
        agentId: "helper",
        sessionTarget: "main",
        activeHours: { start: "22:00", end: "07:00", timezone: "UTC" },
        idleOnly: true,
        payload: {
          kind: "agentTurn",
          message: prompt,
          skipIfScratchEmpty: true,
          includeReasoning: true,
        },
        delivery: { mode: "announce", target: "owner", directPolicy: "block" },
      });
      await cron.update(job.id, { name: "Renamed check" });
      expect(await reload()).toMatchObject({
        activeHours: { start: "22:00", end: "07:00", timezone: "UTC" },
        idleOnly: true,
        payload: { message: prompt, skipIfScratchEmpty: true, includeReasoning: true },
        delivery: { target: "owner", directPolicy: "block" },
      });
      const beforePolicyEdit = await reload();
      const patch = normalizeCronJobPatch({
        activeHours: null,
        idleOnly: null,
        payload: { kind: "agentTurn", skipIfScratchEmpty: false, includeReasoning: false },
        delivery: { target: null, directPolicy: null, channel: "telegram", to: "synthetic-owner" },
      });
      expect(validateCronUpdateParams({ id: job.id, patch })).toBe(true);
      if (!patch) {
        throw new Error("expected normalized automation patch");
      }
      await cron.update(job.id, patch);
      const edited = await reload();
      expect(edited.configRevision).not.toBe(beforePolicyEdit.configRevision);
      expect(edited).not.toHaveProperty("activeHours");
      expect(edited).not.toHaveProperty("idleOnly");
      expect(edited.payload).toMatchObject({
        message: prompt,
        skipIfScratchEmpty: false,
        includeReasoning: false,
      });
      expect(edited.delivery).toMatchObject({
        mode: "announce",
        channel: "telegram",
        to: "synthetic-owner",
      });
      expect(edited.delivery).not.toHaveProperty("target");
      expect(edited.delivery).not.toHaveProperty("directPolicy");
      await expect(cron.update(job.id, { delivery: { target: "owner" } })).rejects.toThrow(
        "owner delivery cannot specify a recipient or thread",
      );
      expect((await reload()).configRevision).toBe(edited.configRevision);
    },
  );
});
