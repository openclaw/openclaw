import { expect, it } from "vitest";
import { readAutomationCreationEvent } from "../../shared/automation-creation.js";
import {
  callGatewayMock,
  createTestCronTool,
  installCronToolTestFixture,
} from "./cron-tool.test-support.js";

installCronToolTestFixture();

it("declares all slots without a scheduler call and resolves only newly saved jobs", async ({
  annotate,
}) => {
  const tool = createTestCronTool({ requireCreationPlan: true });
  await expect(
    tool.execute("unplanned", { action: "add", job: { name: "Unplanned" } }),
  ).rejects.toThrow(/planId/);
  expect(callGatewayMock).not.toHaveBeenCalled();
  const slots = [
    { slotId: "brief", name: "Morning brief" },
    { slotId: "weekly", name: "Weekly review" },
  ];
  const plan = readAutomationCreationEvent(
    (await tool.execute("plan-call", { action: "plan", slots })).details,
  );
  expect(plan).toEqual({ type: "automation_creation_plan", planId: expect.any(String), slots });
  if (!plan) {
    throw new Error("missing plan");
  }
  const { planId } = plan;
  expect((await tool.execute("plan-replay", { action: "plan", slots })).details).toEqual(plan);
  await expect(
    tool.execute("second-plan", { action: "plan", slots: slots.slice(0, 1) }),
  ).rejects.toThrow(/already declared/);
  const job = {
    name: "Morning brief",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "systemEvent", text: "Review" },
  };
  await expect(
    tool.execute("typo", { action: "add", planId, slotId: "missing", job }),
  ).rejects.toThrow(/slot/i);
  expect(callGatewayMock).not.toHaveBeenCalled();
  const weeklyJob = { ...job, name: "Weekly review" };
  callGatewayMock
    .mockResolvedValueOnce({ ...job, enabled: true, id: "saved-job" })
    .mockResolvedValueOnce({
      created: false,
      updated: true,
      job: { ...weeklyJob, enabled: true, id: "existing" },
    });
  const first = await tool.execute("add-1", { action: "add", planId, slotId: "brief", job });
  expect(first.details).toMatchObject({
    automationCreation: {
      type: "automation_creation_result",
      planId,
      slotId: "brief",
      status: "created",
      jobId: "saved-job",
    },
  });
  const second = await tool.execute("add-2", {
    action: "add",
    planId,
    slotId: "weekly",
    job: weeklyJob,
  });
  expect(second.details).toMatchObject({
    automationCreation: {
      type: "automation_creation_result",
      planId,
      slotId: "weekly",
      status: "failed",
    },
  });
  expect(callGatewayMock.mock.calls.map(([{ params }]) => params)).toEqual([
    expect.not.objectContaining({ planId }),
    expect.not.objectContaining({ planId }),
  ]);
  await annotate(
    JSON.stringify([
      { input: { action: "plan", slots }, details: plan },
      { input: { action: "add", planId, slotId: "brief", job }, details: first.details },
      {
        input: { action: "add", planId, slotId: "weekly", job: weeklyJob },
        details: second.details,
      },
    ]),
    "scheduler-contract",
  );
});
