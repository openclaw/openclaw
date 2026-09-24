import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob } from "../../api/types.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("selected automation runtime refresh", () => {
  it("refreshes off-page condition activity without replacing unsaved settings", async () => {
    const selected = createCronViewJob("selected-runtime", {
      name: "Saved automation",
      configRevision: "saved-definition",
      trigger: { script: "return true" },
      state: { triggerEvalCount: 1, nextRunAtMs: Date.now() + 60_000 },
    });
    const pending = createDeferred<CronJob>();
    const trailing = createDeferred<CronJob>();
    let reads = 0;
    const fallback = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.get") {
        expect(params).toEqual({ id: selected.id });
        reads += 1;
        return reads === 1 ? selected : reads === 2 ? pending.promise : trailing.promise;
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    page.routeSearch = `?job=${selected.id}`;
    try {
      await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
      const name = page.querySelector<HTMLInputElement>("#cron-name")!;
      name.value = "Unsaved automation";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
      const definition = page.cron.cronEditingJob;
      const draft = page.cron.cronForm;
      const previousHeader = page.querySelector(".cron-detail-meta")?.textContent;
      gateway.emitRetiredEvent({
        type: "event",
        event: "cron",
        payload: { jobId: selected.id, action: "finished" },
      });
      // An event during the exact read requires one trailing refresh.
      gateway.emitRetiredEvent({
        type: "event",
        event: "cron",
        payload: { jobId: selected.id, action: "finished" },
      });
      pending.resolve({
        ...selected,
        name: "Remote definition",
        configRevision: "remote-definition",
        state: { triggerEvalCount: 7, nextRunAtMs: Date.now() + 86_400_000 },
      });
      trailing.resolve({ ...selected, state: { triggerEvalCount: 9 } });
      await waitForCronPage(() => {
        expect(page.querySelector(".cron-detail-meta")?.textContent).not.toBe(previousHeader);
        expect(page.cron.cronEditingJob?.state?.triggerEvalCount).toBe(9);
      });
      expect(reads).toBe(3);
      expect(page.cron.cronJobs).toEqual([]);
      expect(page.cron.cronEditingJob).toBe(definition);
      expect(page.cron.cronEditingJob?.configRevision).toBe("saved-definition");
      expect(page.querySelector(".cron-detail-title")?.textContent).toContain("Saved automation");
      expect(page.cron.cronForm).toBe(draft);
      expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe("Unsaved automation");
      page
        .querySelector<HTMLElement>('[data-test-id="cron-detail-tab-history"]')!
        .dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      await waitForCronPage(() =>
        expect(page.querySelector(".cron-condition-activity__metric dd")?.textContent).toBe("9"),
      );
    } finally {
      page.remove();
      pending.resolve(selected);
      trailing.resolve(selected);
    }
  });
});
