/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "./chat-pane-mounted.test-support.ts";
import { refreshChatModelAuthStatus } from "./chat-state-refresh.ts";
import { createSessionEventState } from "./chat-state.test-support.ts";

it("updates the open popover after the Gateway deadline without per-run requests", async () => {
  const startedAt = Date.now();
  let now = startedAt;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => {
    vi.useRealTimers();
    clock.mockRestore();
  });
  const key = "agent:main:plan-usage";
  let usedPercent = 1;
  const auth = vi.fn((_method: string, _params: unknown): ModelAuthStatusResult => ({
    ts: now,
    usageRefreshAt: now + 120_000,
    providers: [
      {
        provider: "openai",
        displayName: "OpenAI",
        status: "ok",
        profiles: [
          {
            profileId: "openai:test",
            type: "oauth",
            status: "ok",
            expiry: { at: startedAt + 7 * 86_400_000, remainingMs: 7 * 86_400_000, label: "7d" },
          },
        ],
        usage: { providerId: "openai", plan: "Plus", windows: [{ label: "5h", usedPercent }] },
      },
    ],
  }));
  const fixture = createMountedPanes(
    [
      {
        key,
        agentId: "main",
        kind: "direct",
        sessionId: "plan-usage",
        updatedAt: 1,
        modelProvider: "openai",
        model: "test-model",
      },
    ],
    "main",
    undefined,
    { "models.authStatus": auth },
  );
  await fixture.sessions.refresh({ agentId: "main", force: true });
  const pane = fixture.mount(key);
  const panes = [pane, fixture.mount(key)];
  for (const currentPane of panes) {
    document.body.append(currentPane.element);
    onTestFinished(() => currentPane.element.remove());
  }
  await Promise.all(
    panes.map(async (currentPane) => {
      await refreshPane(currentPane);
      await refreshChatModelAuthStatus(currentPane.state);
    }),
  );
  await waitForSolid(() =>
    expect(pane.element.querySelector(".context-usage summary")).not.toBeNull(),
  );
  pane.element.querySelector<HTMLElement>(".context-usage summary")!.click();
  await waitForSolid(() =>
    expect(
      pane.element.querySelector(".context-usage__limit")?.textContent,
      "initial usage",
    ).toContain("1%"),
  );
  expect(auth).toHaveBeenCalledTimes(1);
  // Keep rendering setup on real timers; advance idle time only to detect polling.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const [index, [elapsed, nextUsage, expectedUsage, calls]] of (
    [
      [10_000, 18, 18, 2],
      [20_000, 22, 18, 2],
      [130_000, 25, 25, 3],
    ] as const
  ).entries()) {
    now = startedAt + elapsed;
    usedPercent = nextUsage;
    fixture.emitGatewayEvent("chat", {
      sessionKey: key,
      agentId: "main",
      runId: `usage-run-${index}`,
      seq: 1,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: now },
    });
    await waitForSolid(() =>
      expect(
        pane.element.querySelector(".context-usage__limit")?.textContent,
        "refreshed usage",
      ).toContain(String(expectedUsage) + "%"),
    );
    expect(auth).toHaveBeenCalledTimes(calls);
    expect(pane.element.querySelector<HTMLDetailsElement>(".context-usage details")?.open).toBe(
      true,
    );
  }
  await vi.advanceTimersByTimeAsync(120_000);
  expect(auth).toHaveBeenCalledTimes(3);
  expect(auth.mock.calls.map(([, params]) => params)).toEqual([
    { agentId: "main" },
    { agentId: "main", refreshUsage: true },
    { agentId: "main", refreshUsage: true },
  ]);
});

it.each(["failure", "session", "connection"] as const)(
  "keeps displayed usage when a post-run read retires through %s",
  async (retirement) => {
    const response = createDeferred<ModelAuthStatusResult>();
    const current: ModelAuthStatusResult = { ts: 1, providers: [] };
    const request = vi.fn(() => response.promise);
    const { state } = createSessionEventState({
      client: createTestGatewayClient(request),
      connected: true,
      modelAuthStatusResult: current,
    });
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const pending = refreshChatModelAuthStatus(state, "retiring-run");
    if (retirement === "failure") {
      response.reject(new Error("Usage refresh failed"));
    } else {
      if (retirement === "session") {
        state.sessionKey = "agent:main:other";
      } else {
        state.connectionEpoch += 1;
      }
      response.resolve({ ts: 2, providers: [] });
    }
    await pending;
    expect(state.modelAuthStatusResult).toBe(current);
    expect(request).toHaveBeenCalledOnce();
  },
);
