/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as downloads from "../../lib/download.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWithClient,
  contextWeight,
  createPage,
  preloadUsage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);

describe("UsagePage detail requests", () => {
  it("releases hydrated export reports after download while the page stays mounted", async () => {
    class ExportReport {
      name = "exported-context";
      blockChars = 10;
    }
    let report: WeakRef<ExportReport> | undefined;
    const snapshot = cacheSnapshot("fresh");
    const session = {
      key: "agent:main:export-lifetime",
      label: "Export lifetime",
      agentId: "main",
      hasContextWeight: true,
      usage: snapshot.result.totals,
    };
    const request = async (method: string, params?: Record<string, unknown>) => {
      if (method === "sessions.usage") {
        const weight = params?.includeContextWeight
          ? {
              ...contextWeight("exported-context"),
              skills: { promptChars: 10, entries: [new ExportReport()] },
            }
          : undefined;
        if (weight) {
          report = new WeakRef(weight.skills.entries[0]!);
        }
        return {
          ...snapshot.result,
          sessions: [{ ...session, ...(weight ? { contextWeight: weight } : {}) }],
        };
      }
      return { providers: [] };
    };
    const download = vi.spyOn(downloads, "downloadTextFile").mockImplementation(() => {});
    const page = await createPage({ request } as unknown as GatewayBrowserClient, true);
    await preloadUsage(page);
    page
      .querySelector(".usage-export-menu")!
      .dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "json" } } }));
    await waitForFast(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0]![1]).toContain("exported-context");
    const collectionControl = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(collectionControl.deref()).toBeUndefined();
    expect(report).toBeDefined();
    expect(report!.deref()).toBeUndefined();
    expect(page.isConnected).toBe(true);
  });

  it("keeps cancelled details displayed and releases them on explicit clear", async () => {
    class DetailPayload {
      timestamp = 1;
      totalTokens = 10;
      role = "user";
      content = "Selected session";
    }
    const payloads: WeakRef<DetailPayload>[] = [];
    const request = async (method: string) => {
      const payload = new DetailPayload();
      payloads.push(new WeakRef(payload));
      return method === "sessions.usage.logs" ? { logs: [payload] } : { points: [payload] };
    };
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    await page.details.timeSeries.load("agent:main:detail-lifetime");
    await page.details.sessionLogs.load("agent:main:detail-lifetime");
    page.details.cancel();
    const collectionControl = new WeakRef({ unowned: true });
    await collectGarbageForTest();
    expect(collectionControl.deref()).toBeUndefined();
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.deref() !== undefined)).toBe(true);
    expect(page.details.timeSeries.data).not.toBeNull();
    expect(page.details.sessionLogs.data).not.toBeNull();

    page.details.clear();
    await collectGarbageForTest();
    expect(payloads.every((payload) => payload.deref() === undefined)).toBe(true);
    expect(page.details.timeSeries.data).toBeNull();
    expect(page.details.sessionLogs.data).toBeNull();
    expect(page.isConnected).toBe(true);
  });

  it("releases a loaded overview when its Gateway identity is replaced", async () => {
    const result = {
      ...cacheSnapshot("fresh").result,
      sessions: [{ key: "agent:main:overview-lifetime", usage: null }],
    };
    const request = async (method: string) =>
      method === "sessions.usage" ? result : { providers: [] };
    const page = await createPage({ request } as unknown as GatewayBrowserClient);
    await page.loadUsage();
    expect(page).toHaveProperty("usageSnapshot.result", result);
    page.context = contextWithClient({
      request: async () => ({}),
    } as unknown as GatewayBrowserClient);
    page.requestUpdate();
    await page.updateComplete;
    // Check the display owner's strong reference, independent of GC scheduling.
    expect(page).toHaveProperty("usageSnapshot", null);
    expect(page.isConnected).toBe(true);
  });
});
