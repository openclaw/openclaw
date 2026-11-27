/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../../api/gateway-connect-errors.ts";
import type { CronJob } from "../../../api/types.ts";
import type { AutomationCreationRow } from "../../../lib/chat/automation-creation-card.ts";
import { createCronJob } from "../../../test-helpers/cron.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountPlan } from "./chat-created-automations.test-support.tsx";

function createdSlot(jobId: string): AutomationCreationRow {
  return { slotId: "slot-" + jobId, name: "Saved job", jobId };
}

it("keeps the first saved job focused when another is confirmed", async () => {
  const alpha = createCronJob("a", "Morning digest");
  const beta = createCronJob("b", "Evening digest");
  const first = createdSlot(alpha.id);
  const card = mountPlan(
    [first],
    (_method, params) => (asOptionalRecord(params)?.id === alpha.id ? alpha : beta),
    undefined,
    true,
  );
  await waitForSolid(() => expect(card.getByRole("switch")).toBeDefined());
  const group = card.getByRole("group");
  const row = card.getByRole("listitem");
  const toggle = card.getByRole("switch");
  toggle.focus();
  card.setPlan({ grouped: true, rows: [createdSlot(beta.id), { ...first }] });
  await waitForSolid(() => expect(card.getAllByRole("switch")).toHaveLength(2));
  expect(card.getByRole("group")).toBe(group);
  expect(card.getAllByRole("listitem")[1]).toBe(row);
  expect(document.activeElement).toBe(toggle);
  expect(card.request).toHaveBeenCalledTimes(2);
});

it("shows a saved job immediately but requires an exact read before enabling controls", async () => {
  const check = Promise.withResolvers<CronJob>();
  const job = createCronJob("a", "Saved title", { enabled: false });
  const card = mountPlan([createdSlot(job.id)], () => check.promise);
  expect(card.getByRole("status").textContent).toContain("Created");
  expect(card.queryByRole("switch")).toBeNull();
  expect(card.queryByRole("link")).toBeNull();
  expect(card.request).toHaveBeenCalledWith("cron.get", { id: job.id }, expect.anything());
  check.resolve(job);
  await waitForSolid(() =>
    expect(card.getByRole("switch", { name: "Resume: Saved title" })).toBeDefined(),
  );
});

it("hydrates a standalone row, reconciles its independent switch, and opens that job's settings", async () => {
  let job = createCronJob("job/1", "Morning digest", {
    enabled: false,
    schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Chicago" },
  });
  const card = mountPlan([createdSlot(job.id)], (method) => {
    if (method === "cron.update") {
      job = { ...job, enabled: true, configRevision: "enabled" };
    }
    return job;
  });
  const toggle = () => card.container.querySelector<HTMLInputElement>("[role=switch]");
  await waitForSolid(() => expect(toggle()?.checked).toBe(false));
  expect(card.queryByRole("heading")).toBeNull();
  expect(card.container.querySelectorAll(".chat-created-automations__clock")).toHaveLength(1);
  const link = card.getByRole("link", { name: /Morning digest/ });
  expect(link.textContent).toMatch(/weekdays.*9:00.*America\/Chicago/i);
  expect(link.getAttribute("href")).toBe("/automations?job=job%2F1&tab=settings");
  toggle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitForSolid(() => {
    expect(card.request).toHaveBeenCalledWith("cron.update", {
      id: job.id,
      patch: { enabled: true },
      expectedConfigRevision: "config-revision-1",
    });
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.disabled).toBe(false);
  });
  expect(card.context.navigate).not.toHaveBeenCalled();
  link.click();
  expect(card.context.navigate).toHaveBeenCalledWith("cron", {
    search: "?job=job%2F1&tab=settings",
  });
  job = { ...job, name: "Edited by agent", enabled: false, configRevision: "paused" };
  card.invalidate();
  await waitForSolid(() => {
    expect(card.getByRole("link").textContent).toContain("Edited by agent");
    expect(toggle()?.checked).toBe(false);
  });
  card.unmount();
  const history = card.render();
  await waitForSolid(() =>
    expect(history.getByRole("switch", { name: "Resume: Edited by agent" })).toBeDefined(),
  );
});

it("keeps a removed job in the group without actions and reconciles later visibility changes", async () => {
  const alpha = createCronJob("a", "Alpha"),
    beta = createCronJob("b", "Beta");
  const jobs = new Map([alpha, beta].map((job) => [job.id, job]));
  const card = mountPlan(
    [createdSlot(alpha.id), createdSlot(beta.id)],
    (_method, params) => {
      const job =
        params && typeof params === "object" && "id" in params && typeof params.id === "string"
          ? jobs.get(params.id)
          : undefined;
      if (!job) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Job not found",
          details: { code: "CRON_JOB_NOT_FOUND", jobId: alpha.id },
        });
      }
      return job;
    },
    ["operator.read"],
  );
  await waitForSolid(() => expect(card.getAllByRole("switch")).toHaveLength(2));
  expect(card.getByRole("heading").textContent).toBe("Automations");
  expect(card.container.querySelectorAll(".chat-created-automations__clock")).toHaveLength(1);
  for (const input of card.container.querySelectorAll<HTMLInputElement>("[role=switch]")) {
    expect(input.disabled).toBe(true);
    input.click();
  }
  expect(card.request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
  jobs.delete(alpha.id);
  card.invalidate();
  await waitForSolid(() => {
    expect(card.getAllByRole("switch")).toHaveLength(1);
    expect(card.queryByRole("link", { name: /Alpha/ })).toBeNull();
    expect(card.getByText("Removed", { exact: true })).toBeDefined();
    expect(card.queryByRole("button")).toBeNull();
  });
  jobs.set(alpha.id, alpha);
  card.invalidate();
  await waitForSolid(() => expect(card.getByRole("link", { name: /Alpha/ })).toBeDefined());
  expect(card.getAllByRole("switch")).toHaveLength(2);
});

it("offers Retry when reading the job fails temporarily", async () => {
  const job = createCronJob("notes", "Weekly notes");
  const card = mountPlan(
    [createdSlot(job.id)],
    vi.fn().mockRejectedValueOnce(new Error("Timed out")).mockResolvedValue(job),
  );
  const retry = await waitForSolid(() => card.getByRole("button", { name: "Retry" }));
  expect(card.getByRole("status").textContent).toContain("Automation unavailable");
  retry.click();
  await waitForSolid(() => expect(card.getByRole("link", { name: /Weekly notes/ })).toBeDefined());
});

it("keeps the confirmed switch state while its reconciliation read is in flight", async () => {
  const paused = createCronJob("a", "Morning digest", { enabled: false });
  const resumed = { ...paused, enabled: true, configRevision: "resumed" };
  const reconcile = Promise.withResolvers<CronJob>();
  const handler = vi
    .fn()
    .mockResolvedValueOnce(paused)
    .mockResolvedValueOnce(resumed)
    .mockReturnValueOnce(reconcile.promise);
  const card = mountPlan([createdSlot(paused.id)], handler);
  await waitForSolid(() =>
    expect(card.getByRole("switch", { name: "Resume: Morning digest" })).toBeDefined(),
  );
  card.getByRole("switch").click();
  await waitForSolid(() =>
    expect(card.request.mock.calls.map(([method]) => method)).toEqual([
      "cron.get",
      "cron.update",
      "cron.get",
    ]),
  );
  const input = card.getByRole<HTMLInputElement>("switch", { name: "Pause: Morning digest" });
  expect(input.checked).toBe(true);
  expect(input.disabled).toBe(true);
  handler.mockReturnValueOnce(reconcile.promise);
  card.invalidate();
  await waitForSolid(() => expect(card.request).toHaveBeenCalledTimes(4));
  expect(input.checked).toBe(true);
  expect(input.disabled).toBe(true);
  reconcile.resolve(resumed);
  await waitForSolid(() => expect(input.disabled).toBe(false));
});

it("reconciles a conflicted toggle without replaying it", async () => {
  let job = createCronJob("notes", "Weekly notes");
  const card = mountPlan([createdSlot(job.id)], (method) => {
    if (method === "cron.update") {
      job = { ...job, name: "Changed elsewhere", configRevision: "newer" };
      throw new Error("Automation changed on the Gateway");
    }
    return job;
  });
  await waitForSolid(() => expect(card.getByRole("switch")).toBeDefined());
  card.getByRole("switch").click();
  await waitForSolid(() => {
    expect(card.getByRole("alert").textContent).toContain("Automation changed");
    expect(card.getByRole("link").textContent).toContain("Changed elsewhere");
    expect(card.container.querySelector<HTMLInputElement>("input")?.checked).toBe(true);
  });
  expect(card.request.mock.calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
});

it("retires an in-flight exact read on disconnect, even when the reconnect reuses the client", async () => {
  const stale = Promise.withResolvers<CronJob>();
  const current = createCronJob("a", "Current", { enabled: false });
  const card = mountPlan(
    [createdSlot(current.id)],
    vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(current),
  );
  await waitForSolid(() => expect(card.request).toHaveBeenCalledTimes(1));
  const snapshot = card.source.gateway.snapshot;
  card.source.publish({ ...snapshot, phase: "reconnecting" });
  flush();
  expect(card.queryByRole("switch")).toBeNull();
  card.source.publish(snapshot);
  await waitForSolid(() =>
    expect(card.getByRole("switch", { name: "Resume: Current" })).toBeDefined(),
  );
  stale.resolve({ ...current, name: "Obsolete", enabled: true });
  await stale.promise;
  flush();
  expect(card.getByRole("link").textContent).toContain("Current");
  expect(card.container.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
});
