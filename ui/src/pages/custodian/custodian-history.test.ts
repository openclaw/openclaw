/* @vitest-environment jsdom */

import type { SystemChangesListResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as uuid from "../../lib/uuid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

function button(page: HTMLElement, selector: string) {
  return page.querySelector<HTMLButtonElement>(selector)!;
}

describe("custodian change history", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("retains expanded change cards through a failed delayed read and retries", async () => {
    const initial = createDeferred<SystemChangesListResult>();
    const more = createDeferred<SystemChangesListResult>();
    const retry = createDeferred<SystemChangesListResult>();
    const historyRequests = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise)
      .mockReturnValueOnce(retry.promise);
    const request = vi.fn((method: string) =>
      method === "openclaw.changes.list"
        ? historyRequests()
        : Promise.resolve({ sessionId: "custodian-session", reply: "Ready.", action: "none" }),
    );
    const harness = createContext(request, ["openclaw.chat", "openclaw.changes.list"]);
    const { page } = await mountPage(harness.context, { onboarding: false });
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() => expect(historyRequests).toHaveBeenCalledOnce());
    await waitForFast(() =>
      expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull(),
    );
    const entry = {
      id: "config-audit:first",
      at: 1_700_000_000_000,
      kind: "config-write" as const,
      source: "config-rpc" as const,
      summary: "Changed the synthetic gateway port",
      changedPaths: ["gateway.port"],
    };
    initial.resolve({ entries: [entry], nextCursor: "next-page" });
    await waitForFast(() =>
      expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(1),
    );
    const card = page.querySelector(".custodian__change-card");
    const details = page.querySelector<HTMLDetailsElement>(".custodian__change-paths")!;
    details.open = true;
    button(page, ".custodian__history-more").click();
    button(page, ".custodian__history-more").click();
    await waitForFast(() => expect(historyRequests).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(button(page, ".custodian__history-more").disabled).toBe(true));
    expect(page.querySelector(".custodian__change-card")).toBe(card);
    more.reject(new Error("synthetic request failure"));
    await waitForFast(() => expect(page.querySelector(".custodian__history-error")).not.toBeNull());
    expect(page.querySelector(".custodian__change-card")).toBe(card);
    expect(details.open).toBe(true);
    button(page, ".custodian__history-error button").click();
    await waitForFast(() => expect(historyRequests).toHaveBeenCalledTimes(3));
    expect(request).toHaveBeenLastCalledWith("openclaw.changes.list", { limit: 50 });
    await waitForFast(() => expect(page.querySelector(".custodian__history-error")).toBeNull());
    retry.resolve({
      entries: [{ ...entry, id: "config-audit:retry", summary: "Retried successfully" }],
    });
    await waitForFast(() =>
      expect(page.querySelector(".custodian__history")?.textContent).toContain(
        "Retried successfully",
      ),
    );
    expect(page.querySelector(".custodian__history")?.textContent).not.toContain(entry.summary);
  });

  it("clears accepted history while a replacement connection loads", async () => {
    const entry = {
      id: "config-audit:old",
      at: 1_700_000_000_000,
      kind: "config-write" as const,
      source: "config-rpc" as const,
      summary: "Old connection history",
    };
    const request = vi.fn(async (method: string) =>
      method === "openclaw.changes.list"
        ? { entries: [entry] }
        : { sessionId: "custodian-session", reply: "Ready.", action: "none" },
    );
    const harness = createContext(request, ["openclaw.chat", "openclaw.changes.list"]);
    const { page } = await mountPage(harness.context, { onboarding: false });
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() => expect(page.textContent).toContain(entry.summary));

    const pending = createDeferred<SystemChangesListResult>();
    const replacement = createContext(
      vi.fn((method: string) =>
        method === "openclaw.changes.list"
          ? pending.promise
          : Promise.resolve({ sessionId: "replacement-session", reply: "Ready.", action: "none" }),
      ),
      ["openclaw.chat", "openclaw.changes.list"],
    );
    harness.setGatewaySnapshot({ client: replacement.context.gateway.snapshot.client });
    await waitForFast(() => expect(page.querySelector(".custodian__history")).toBeNull());
    button(page, ".custodian__history-toggle").click();
    await waitForFast(() =>
      expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull(),
    );
    expect(page.textContent).not.toContain(entry.summary);
    pending.resolve({ entries: [{ ...entry, id: "config-audit:new", summary: "New history" }] });
    await waitForFast(() => expect(page.textContent).toContain("New history"));
    expect(page.textContent).not.toContain(entry.summary);
  });
});
