import { expect, it, vi } from "vitest";
import { prepareCronStateWorkerCommand } from "./dispatch.worker.js";

vi.mock("../service/timer-outcomes.js", () => {
  throw new Error("Startup commands must not load run-outcome handling");
});

vi.mock("../../config/sessions/session-accessor.js", () => {
  throw new Error("Startup commands must not load session access");
});

vi.mock("../delivery-plan.js", () => {
  throw new Error("Startup commands must not load delivery resolution");
});

it.each([
  "cron.planStartup",
  "cron.releaseReservations",
  "cron.mutateJobs",
  "cron.maintainHistory",
  "cron.scheduleUnowned",
])("prepares %s without loading execution-only runtimes", async (type) => {
  expect(await prepareCronStateWorkerCommand(type)).toBeUndefined();
});
