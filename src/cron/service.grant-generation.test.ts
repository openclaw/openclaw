import { expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-grant-generation-",
});

function readGrantDefinitionProjection(jobId: string) {
  return openOpenClawStateDatabase()
    .db.prepare(
      `SELECT grant_definition_revision, grant_definition_generation
       FROM cron_jobs
       WHERE job_id = ?`,
    )
    .get(jobId);
}

it("preserves the grant generation when clearing an absent description", async () => {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  await cron.start();
  try {
    const created = await cron.add({
      name: "description-free",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
    });
    const before = readGrantDefinitionProjection(created.id);
    expect(before).toMatchObject({
      grant_definition_generation: 1,
      grant_definition_revision: expect.stringMatching(/^sha256:/),
    });

    const updated = await cron.update(created.id, { description: "" });
    const after = readGrantDefinitionProjection(created.id);

    expect(updated.description).toBeUndefined();
    expect(after).toEqual(before);
  } finally {
    cron.stop();
  }
});
