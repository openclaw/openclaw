import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import type { CronJob, CronJobCreate } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

function createInput(
  sessionTarget: CronJobCreate["sessionTarget"],
  payload: CronJobCreate["payload"] = { kind: "agentTurn", message: "hello" },
): CronJobCreate {
  return {
    name: "initial delivery",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "now",
    failureAlert: false,
    payload,
  };
}

it.each([
  ["isolated", { kind: "script", script: "return { notify: 'hello' }" }, { mode: "announce" }],
  ["main", { kind: "agentTurn", message: "hello" }, undefined],
  ["isolated", { kind: "systemEvent", text: "tick" }, undefined],
] as const)("resolves initial delivery for %s %j", (target, payload, expected) => {
  expect(resolveInitialCronDelivery(createInput(target, payload))).toEqual(expected);
});

// Direct service callers do not pass through normalizeCronJobCreate, so keep
// the public add and declarative convergence paths pinned to the same default.
const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-initial-delivery-",
});

describe("CronService initial delivery", () => {
  let cron: CronService;
  beforeEach(async () => {
    const { storePath } = await makeStorePath();
    cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
  });
  afterEach(() => cron.stop());
  async function expectPersistedAnnounce(job: CronJob) {
    expect(job.delivery).toEqual({ mode: "announce" });
    await expect(cron.readJob(job.id)).resolves.toMatchObject({ delivery: { mode: "announce" } });
  }
  it.each(["current", "session:project-alpha"] as const)(
    "persists announce delivery for direct %s jobs",
    async (sessionTarget) => {
      await expectPersistedAnnounce(await cron.add(createInput(sessionTarget)));
    },
  );

  it("keeps announce delivery when a declaration converges", async () => {
    const declaration = {
      ...createInput("session:project-alpha"),
      declarationKey: "agent:ops:initial-delivery",
    };

    const created = await cron.add(declaration);
    expect(created.delivery).toEqual({ mode: "announce" });

    const converged = await cron.add(declaration, { enabledExplicit: true });
    if (!("job" in converged)) {
      throw new Error("expected declarative cron result");
    }
    expect(converged).toMatchObject({
      created: false,
      updated: false,
      job: { delivery: { mode: "announce" } },
    });
    await expectPersistedAnnounce(converged.job);
  });
});
