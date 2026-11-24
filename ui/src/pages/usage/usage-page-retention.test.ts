/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as downloads from "../../lib/download.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { selectUsageExport } from "./export-menu.test-support.ts";
import { createUsageDetailFixture } from "./usage-details.test-support.ts";
import {
  cacheSnapshot,
  cleanupUsagePageTest,
  contextWeight,
  createUsagePageFixture,
  loadUsagePage,
} from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
async function collectWithControl() {
  const control = new WeakRef({ unowned: true });
  await collectGarbageForTest();
  expect(control.deref()).toBeUndefined();
}

it("releases hydrated export reports after download while the page stays mounted", async () => {
  let report: WeakRef<object> | undefined;
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
      const weight = params?.includeContextWeight ? contextWeight("exported-context") : undefined;
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
  const { page } = await loadUsagePage(request);
  await selectUsageExport(page.querySelector(".usage-export-menu")!, "json");
  await waitForFast(() => expect(download).toHaveBeenCalledOnce());
  expect(download.mock.calls[0]![1]).toContain("exported-context");
  await collectWithControl();
  expect(report).toBeDefined();
  expect(report!.deref()).toBeUndefined();
  expect(page.isConnected).toBe(true);
});

it("keeps cancelled details displayed and releases them on explicit clear", async () => {
  const payloads: WeakRef<object>[] = [];
  const request = async (method: string) => {
    const payload = { timestamp: 1, totalTokens: 10, role: "user", content: "Selected session" };
    payloads.push(new WeakRef(payload));
    return method === "sessions.usage.logs" ? { logs: [payload] } : { points: [payload] };
  };
  const { details } = createUsageDetailFixture({ request } as unknown as GatewayBrowserClient);
  await details.timeSeries.load("agent:main:detail-lifetime");
  await details.sessionLogs.load("agent:main:detail-lifetime");
  details.cancel();
  await collectWithControl();
  expect(payloads).toHaveLength(2);
  expect(payloads.every((payload) => payload.deref() !== undefined)).toBe(true);
  for (const detail of [details.timeSeries, details.sessionLogs]) {
    expect(detail.data).not.toBeNull();
  }

  details.clear();
  await collectGarbageForTest();
  expect(payloads.every((payload) => payload.deref() === undefined)).toBe(true);
  expect(details).toMatchObject({ timeSeries: { data: null }, sessionLogs: { data: null } });
});

it("releases a loaded overview when its Gateway identity is replaced", async () => {
  let payload: WeakRef<object> | undefined;
  const snapshot = cacheSnapshot("fresh");
  const request = async (method: string) => {
    if (method === "sessions.usage") {
      const report = { key: "agent:main:overview-lifetime", usage: null };
      payload = new WeakRef(report);
      return { ...snapshot.result, sessions: [report] };
    }
    return { providers: [] };
  };
  const { page, context } = await createUsagePageFixture(request, false);
  await page.refresh();
  expect(payload).toBeDefined();
  context.setGatewaySnapshot({
    client: { request: async () => ({}) } as unknown as GatewayBrowserClient,
  });
  await page.updateComplete;
  expect(page.usageResult).toBeNull();
  await collectWithControl();
  expect(payload!.deref()).toBeUndefined();
  expect(page.isConnected).toBe(true);
});
