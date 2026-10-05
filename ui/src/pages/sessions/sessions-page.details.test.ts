/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createContext, createGateway, createRenderedPage } from "./sessions-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each([
  { entry: "interactive", closeBeforeReply: false },
  { entry: "deep-link", closeBeforeReply: false },
  { entry: "interactive", closeBeforeReply: true },
])(
  "loads full settings for the expanded compact row ($entry, closed: $closeBeforeReply)",
  async ({ entry, closeBeforeReply }) => {
    const row: GatewaySessionRow = {
      key: "agent:main:details",
      sessionId: "details-session",
      kind: "direct",
      updatedAt: 1,
      rowMode: "compact",
    };
    const descriptor = createDeferred<{ session: GatewaySessionRow }>();
    let description = descriptor.promise;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return sessionsResult([row], 1);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.groups.list") {
        return { names: [], sectionOrder: [] };
      }
      if (method === "sessions.describe") {
        return description;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const connection = createGateway(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(connection.gateway);
    const page = await createRenderedPage(
      createContext(connection.gateway, sessions),
      sessionsResult([row], 1),
      "active",
      entry === "deep-link" ? row.key : null,
    );
    const listReads = request.mock.calls.filter(([method]) => method === "sessions.list").length;
    if (entry === "interactive") {
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        0,
      );
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await page.updateComplete;
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(1);
    expect(page.querySelector<HTMLSelectElement>(".session-details-panel select")?.disabled).toBe(
      true,
    );
    const held = page.result;
    if (closeBeforeReply) {
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await page.updateComplete;
    }

    const full: GatewaySessionRow = {
      ...row,
      rowMode: undefined,
      agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "high", label: "high" },
      ],
      thinkingDefault: "high",
    };
    descriptor.resolve({ session: full });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
      listReads,
    );
    if (closeBeforeReply) {
      expect(page.querySelector(".session-details-panel")).toBeNull();
      expect(page.result).toBe(held);
      return;
    }
    const thinking = page.querySelector<HTMLSelectElement>(".session-details-panel select")!;
    expect(thinking.disabled).toBe(false);
    expect([...thinking.options].map((option) => option.textContent?.trim())).toEqual([
      "Inherited: High",
      "Off",
      "High",
    ]);
    expect(page.querySelector(".session-details-panel")?.textContent).toContain(
      "claude-cli (fallback none)",
    );
    if (entry === "interactive") {
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await page.updateComplete;
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        1,
      );
      description = Promise.resolve({ session: { ...full, updatedAt: 2, thinkingDefault: "off" } });
      connection.emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { key: row.key, agentId: "main", reason: "patch" },
      });
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        2,
      );
      expect(
        page
          .querySelector<HTMLSelectElement>(".session-details-panel select")
          ?.options[0]?.textContent?.trim(),
      ).toBe("Inherited: Off");
    }
  },
);
