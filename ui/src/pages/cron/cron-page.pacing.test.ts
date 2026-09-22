import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob, selectSegmented } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage pacing", () => {
  it.each([
    { name: "minimum bound", kind: "every", pacing: { min: "5m" }, once: false },
    { name: "maximum bound", kind: "cron", pacing: { max: "1h" }, once: false },
    { name: "both bounds", kind: "every", pacing: { min: "5m", max: "1h" }, once: false },
    { name: "no pacing", kind: "cron", pacing: undefined, once: false },
    { name: "a one-time copy", kind: "every", pacing: { min: "5m", max: "1h" }, once: true },
  ] as const)("duplicates pacing correctly for $name", async ({ kind, pacing, once }) => {
    const source = createCronViewJob("paced-source", {
      schedule: kind === "every" ? { kind, everyMs: 60_000 } : { kind, expr: "0 9 * * *" },
      pacing,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check again at the proposed cadence" },
      delivery: { mode: "none" },
      state: {},
    });
    const original = structuredClone(source);
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse([source]);
      }
      if (method === "cron.add") {
        return { id: "paced-copy" };
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.querySelector(".cron-job-menu")).not.toBeNull());
    page
      .querySelector(".cron-job-menu")!
      .dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: { value: "clone" } }, bubbles: true }),
      );
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe("Daily ping copy");

    if (once) {
      selectSegmented(page.querySelector('[data-test-id="cron-schedule-kind-at"]') as HTMLElement);
      await page.updateComplete;
      const at = page.querySelector("#cron-schedule-at") as HTMLInputElement;
      at.value = "2099-01-01T12:00";
      at.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await waitForCronPage(() => {
      const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
      expect(submit).not.toBeNull();
      expect(submit.disabled).toBe(false);
    });
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({
          name: "Daily ping copy",
          schedule: expect.objectContaining({ kind: once ? "at" : kind }),
        }),
      ),
    );
    await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));
    const submitted = request.mock.calls.find(([method]) => method === "cron.add")?.[1];
    if (pacing && !once) {
      expect(submitted).toHaveProperty("pacing", pacing);
    } else {
      expect(submitted).not.toHaveProperty("pacing");
    }
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    expect(source).toEqual(original);
  });

  it.each([false, true])("preserves valid pacing when editing (once: %s)", async (once) => {
    const source = createCronViewJob("paced-edit", {
      schedule: { kind: "every", everyMs: 60_000 },
      pacing: { min: "5m", max: "1h" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check again at the proposed cadence" },
      delivery: { mode: "none" },
      state: {},
    });
    const saved: CronJob = {
      ...source,
      name: "Edited task",
      schedule: once ? { kind: "at", at: "2099-01-01T12:00:00.000Z" } : source.schedule,
      pacing: once ? undefined : source.pacing,
      configRevision: "saved-revision",
    };
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse([source]);
      }
      return method === "cron.update" ? saved : fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.querySelector(".cron-table__row")).not.toBeNull());
    (page.querySelector(".cron-table__row") as HTMLElement).click();
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = saved.name;
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    if (once) {
      selectSegmented(page.querySelector('[data-test-id="cron-schedule-kind-at"]') as HTMLElement);
      await page.updateComplete;
      const at = page.querySelector("#cron-schedule-at") as HTMLInputElement;
      at.value = "2099-01-01T12:00";
      at.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
    }
    const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.click();
    await waitForCronPage(() =>
      expect(page.cron.cronEditingJob?.configRevision).toBe("saved-revision"),
    );
    await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
    const submitted = request.mock.calls.find(([method]) => method === "cron.update")?.[1];
    expect(submitted).toMatchObject({
      id: source.id,
      expectedConfigRevision: "config-revision-paced-edit",
      patch: { name: saved.name },
    });
    if (once) {
      expect(submitted).toHaveProperty("patch.schedule.kind", "at");
      expect(submitted).toHaveProperty("patch.pacing", null);
    } else {
      expect(submitted).not.toHaveProperty("patch.pacing");
    }
    expect(source.pacing).toEqual({ min: "5m", max: "1h" });
  });
});
