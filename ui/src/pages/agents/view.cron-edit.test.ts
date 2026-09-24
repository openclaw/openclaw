import { render } from "lit";
import { expect, it, vi } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it.each([
  { name: "enabled authorized job", enabled: true, canRunCron: true, canRun: true },
  { name: "paused authorized job", enabled: false, canRunCron: true, canRun: true },
  { name: "enabled unauthorized job", enabled: true, canRunCron: false, canRun: false },
  { name: "paused unauthorized job", enabled: false, canRunCron: false, canRun: false },
])("preserves edit links and gates Run Now for a $name", ({ enabled, canRunCron, canRun }) => {
  const container = document.createElement("div");
  const onCronRunNow = vi.fn();
  const job: CronJob = {
    id: "job /?&",
    name: "Weekly report",
    agentId: "alpha",
    enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize notes." },
    state: {},
  };
  const props = createProps({
    activePanel: "cron",
    selectedAgentId: "alpha",
    basePath: "/gateway",
    onCronRunNow,
  });
  render(
    renderAgents({
      ...props,
      access: { ...props.access, canRunCron },
      cron: { ...props.cron, cronJobs: [job] },
    }),
    container,
  );
  const link = [...container.querySelectorAll("a")].find(
    (entry) => entry.textContent?.trim() === "Edit",
  );
  expect(link?.getAttribute("href")).toBe("/gateway/automations?job=job%20%2F%3F%26");

  const jobRow = [...container.querySelectorAll(".settings-row")].find(
    (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === job.name,
  );
  const runNow = [...(jobRow?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === "Run Now",
  );
  expect(runNow).toBeInstanceOf(HTMLButtonElement);
  expect(runNow?.disabled).toBe(!canRun);
  runNow?.click();
  if (canRun) {
    expect(onCronRunNow).toHaveBeenCalledTimes(1);
    expect(onCronRunNow).toHaveBeenCalledWith(job.id);
  } else {
    expect(onCronRunNow).not.toHaveBeenCalled();
  }
});
