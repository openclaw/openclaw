import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { getLogbookState, loadLogbook } from "./logbook-controller.ts";
import { Logbook } from "./logbook-view.tsx";

describe("Logbook view", () => {
  it("renders timeline clocks in the capture host timezone and preserves detail text", () => {
    const host = {};
    const state = getLogbookState(host);
    state.day = "2026-01-01";
    state.status = {
      captureEnabled: true,
      capturePaused: false,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: false,
      visionModelSource: "missing",
      today: "2026-01-01",
      todayCards: 1,
      timeZone: "America/Los_Angeles",
    };
    state.timeline = {
      day: state.day,
      cards: [
        {
          id: 1,
          day: state.day,
          startMs: Date.UTC(2026, 0, 2, 0, 30),
          endMs: Date.UTC(2026, 0, 2, 1, 30),
          title: "Work",
          summary: "Summary",
          detail: "  API_TOKEN = computeToken()  ",
          category: "Coding",
          distractions: [],
        },
      ],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    };
    state.expandedCardIds = new Set([1]);

    const container = document.createElement("div");
    const view = mountSolid(() => <Logbook host={host} client={null} connected={false} />, {
      container,
    });
    try {
      flush();

      const timeOptions = {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      } satisfies Intl.DateTimeFormatOptions;
      const expectedTime = [Date.UTC(2026, 0, 2, 0, 30), Date.UTC(2026, 0, 2, 1, 30)]
        .map((ms) => new Date(ms).toLocaleTimeString(i18n.getLocale(), timeOptions))
        .join("–");
      expect(container.querySelector(".logbook-card__time")?.textContent?.trim()).toBe(
        expectedTime,
      );
      expect(container.querySelector(".logbook-card__duration")?.textContent?.trim()).toBe("1h");
      expect(container.querySelector(".logbook-card__detail")?.textContent).toBe(
        "API_TOKEN = computeToken()",
      );
    } finally {
      view.unmount();
    }
  });

  it("keeps the capture toggle label and enabled state current", async () => {
    vi.useFakeTimers();
    const host = {};
    const state = getLogbookState(host);
    let serverStatus = {
      captureEnabled: false,
      capturePaused: false,
      captureIntervalSeconds: 30,
      analysisIntervalMinutes: 15,
      retentionDays: 30,
      pendingFrames: 0,
      analysisRunning: false,
      visionModelSource: "missing" as const,
      today: state.day,
      todayCards: 0,
      timeZone: "UTC",
    };
    const timeline = {
      day: state.day,
      cards: [],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    };
    state.status = serverStatus;
    state.timeline = timeline;
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === "logbook.capture.set") {
        serverStatus = { ...serverStatus, capturePaused: (params as { paused: boolean }).paused };
        return serverStatus;
      }
      if (method === "logbook.status") {
        return serverStatus;
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      if (method === "logbook.timeline") {
        return timeline;
      }
      throw new Error(`Unexpected Logbook request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const view = mountSolid(() => <Logbook host={host} client={client} connected={true} />);
    try {
      flush();
      const toggle = view.getByRole("button", { name: "Pause" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);

      serverStatus = { ...serverStatus, captureEnabled: true };
      await loadLogbook(state, client);
      flush();
      expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
      expect(toggle.disabled).toBe(false);

      toggle.click();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(view.getByRole("button", { name: "Resume" })).toBe(toggle);
      expect(toggle.disabled).toBe(false);
      expect(request).toHaveBeenCalledWith("logbook.capture.set", { paused: true });

      toggle.click();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(view.getByRole("button", { name: "Pause" })).toBe(toggle);
      expect(request).toHaveBeenCalledWith("logbook.capture.set", { paused: false });

      serverStatus = { ...serverStatus, captureEnabled: false };
      await loadLogbook(state, client);
      flush();
      expect(toggle.disabled).toBe(true);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
