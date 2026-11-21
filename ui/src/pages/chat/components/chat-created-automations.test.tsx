/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { CronJob } from "../../../api/types.ts";
import type { AutomationCreationRow } from "../../../lib/chat/automation-creation-card.ts";
import { createCronJob } from "../../../test-helpers/cron.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountPlan } from "./chat-created-automations.test-support.tsx";

function createdSlot(jobId: string): AutomationCreationRow {
  return { slotId: "slot-" + jobId, name: "Planned job", status: "created", jobId };
}

it("reserves the whole plan before any job exists and settles its keyed slots independently", async () => {
  const pending = (slotId: string, name: string): AutomationCreationRow => ({
    slotId,
    name,
    status: "pending",
  });
  const alpha = pending("first", "Morning digest");
  const beta = pending("second", "Evening digest");
  const job = createCronJob("j2", "Evening recap");
  const card = mountPlan([alpha, beta], () => job);
  const group = card.getByRole("group", { name: "Automations" });
  const heading = card.getByRole("heading", { name: "Automations" });
  const rows = () => card.getAllByRole("listitem");
  const [first, second] = rows();
  if (!first || !second) {
    throw new Error("Both declared slots must be mounted");
  }
  expect(first.querySelector("[role=status]")?.textContent).toContain(
    "Morning digestCreating automation…",
  );
  expect(second.textContent).toContain("Evening digest");
  expect(card.container.querySelectorAll(".chat-created-automations__clock")).toHaveLength(1);
  expect(
    card.container.querySelectorAll(
      ".chat-created-automations__switch-placeholder[aria-hidden=true]",
    ),
  ).toHaveLength(2);
  expect(group.querySelector("a, button, input, [tabindex], [role=switch]")).toBeNull();
  expect(card.request).not.toHaveBeenCalled();

  const created = { ...beta, status: "created", jobId: job.id } as const;
  card.setPlan({ planId: "plan", rows: [{ ...alpha }, created] });
  await waitForSolid(() => expect(card.getByRole("link", { name: /Evening recap/ })).toBeDefined());
  expect(card.getAllByRole("switch")).toHaveLength(1);
  expect(rows()[0]).toBe(first);
  expect(rows()[1]).toBe(second);
  const toggle = card.getByRole("switch");
  toggle.focus();
  card.setPlan({ planId: "plan", rows: [{ ...alpha, status: "failed" }, { ...created }] });
  flush();
  expect(card.getByRole("group")).toBe(group);
  expect(card.getByRole("heading")).toBe(heading);
  expect(rows()[0]).toBe(first);
  expect(rows()[1]).toBe(second);
  expect(first.textContent).toContain("Not created");
  expect(first.querySelector("a, button, input, [tabindex], [role=switch]")).toBeNull();
  expect(first.querySelector("svg[aria-hidden=true]")).not.toBeNull();
  expect(card.getByRole("switch")).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
  expect(card.request).toHaveBeenCalledTimes(1);
});

it("makes a newly confirmed row actionable while the exact read and its sibling are still pending", async () => {
  const check = Promise.withResolvers<CronJob>();
  const pending = { status: "pending", slotId: "a", name: "Hint" } as const;
  const sibling = { status: "pending", slotId: "b", name: "Unfinished" } as const;
  const job = createCronJob("a", "Saved title", { enabled: false });
  const changed = { ...job, enabled: true, configRevision: "after-write" };
  const card = mountPlan([pending, sibling], (method) =>
    method === "cron.update" ? changed : check.promise,
  );
  const saved = {
    ...pending,
    status: "created",
    jobId: job.id,
    definition: {
      id: job.id,
      name: job.name,
      enabled: false,
      configRevision: "config-revision-1",
      schedule: { kind: "cron", expr: "0 * * * *" },
    },
  } as const;
  card.setPlan({ planId: "plan", rows: [saved, sibling] });
  flush();
  const toggle = card.getByRole<HTMLInputElement>("switch", { name: "Resume: Saved title" });
  expect(toggle.disabled).toBe(false);
  expect(
    card.container.querySelectorAll(".chat-created-automations__switch-placeholder"),
  ).toHaveLength(1);
  toggle.click();
  await waitForSolid(() =>
    expect(card.request).toHaveBeenCalledWith("cron.update", {
      id: "a",
      expectedConfigRevision: job.configRevision,
      patch: { enabled: true },
    }),
  );
  check.resolve(changed);
  await waitForSolid(() => expect(toggle.checked).toBe(true));
});

it.each([true, false])(
  "does not treat a shared receipt as read permission or as current on reload (history=%s)",
  async (history) => {
    const pending = { slotId: "a", name: "Hint", status: "pending" } as const;
    const saved = {
      ...pending,
      status: "created",
      jobId: "a",
      definition: { id: "a", name: "Former title", enabled: true, configRevision: "old" },
    } as const;
    const check = Promise.withResolvers<CronJob>();
    const card = mountPlan(
      [history ? saved : pending],
      () => check.promise,
      history ? ["operator.admin"] : ["operator.read"],
    );
    if (!history) {
      card.setPlan({ planId: "plan", rows: [saved] });
    }
    flush();
    expect(card.queryByRole("switch")).toBeNull();
    expect(card.queryByRole("link")).toBeNull();
    check.reject(new Error("Not found or inaccessible"));
    await waitForSolid(() => expect(card.getByRole("status").textContent).toContain("unavailable"));
  },
);

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

it("groups identities under one clock and heading; unavailable jobs have no link or switch", async () => {
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
        throw new Error("cron job not found");
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
    expect(card.getByRole("status").textContent).toContain("unavailable");
  });
  jobs.set(alpha.id, alpha);
  card.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(card.getByRole("link", { name: /Alpha/ })).toBeDefined());
  expect(card.getAllByRole("switch")).toHaveLength(2);
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
