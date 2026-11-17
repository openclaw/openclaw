import type { CDPSession, Locator, Page } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import {
  navigateCriticalPath,
  type CriticalPathCapture,
} from "../../scripts/lib/control-ui-critical-path.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("includes Pages work without moving the legacy activation CPU boundary", async () => {
  let now = 10;
  let taskMs = 0;
  let pagesVisible = false;
  let startedMs = 0;
  const actions: string[] = [];
  const rpc = (method: string, requestMs: number, responseMs: number) => ({
    method,
    params: {},
    requestMs,
    responseMs,
    requestBytes: 1,
    responseBytes: 1,
  });
  const rpcs: CriticalPathCapture["rpcs"] = [rpc("connect", 0, 5)];
  const activate = () => {
    actions.push("cron");
    taskMs += 50;
    rpcs.push(rpc("cron.list", 40, 70));
    now = 90;
  };
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("window", {
    __coldLoad: {
      read: () => ({
        pending: 0,
        queued: 0,
        idleMs: 800,
        get rpcs() {
          // Full census work must stay outside both CPU intervals.
          taskMs += 5;
          now += 5;
          return rpcs;
        },
      }),
    },
    __criticalPath: {
      start: () => {
        startedMs = now;
      },
      ready: () => now >= 90,
      read: () => ({
        name: "cron",
        documentUrl: "http://localhost/automations",
        timeOrigin: 0,
        startedMs,
        readyMs: 70,
        elapsedMs: 70 - startedMs,
        capturedMs: now,
        rpcs: rpcs.filter((entry) => entry.responseMs >= startedMs),
        resources: [],
      }),
    },
  });
  const destination = {
    first() {
      return this;
    },
    isVisible: async () => pagesVisible,
    waitFor: async () => {
      expect(pagesVisible).toBe(true);
    },
    evaluate: async (
      body: (element: { click: () => void }, route: string) => unknown,
      route: string,
    ) => body({ click: activate }, route),
  };
  const page = {
    locator: (selector: string) => {
      if (selector === ".settings-sidebar") {
        return { isVisible: async () => false };
      }
      if (selector === '[data-navigation-view="pages"]') {
        return {
          click: async () => {
            actions.push("pages");
            taskMs += 30;
            rpcs.push(rpc("sessions.list", 10, 30));
            now = 40;
            pagesVisible = true;
          },
        };
      }
      return destination as unknown as Locator;
    },
    evaluate: async (body: (argument?: unknown) => unknown, argument?: unknown) => body(argument),
    waitForFunction: async (body: () => unknown) => {
      expect(body()).toBeTruthy();
    },
  } as unknown as Page;
  const cdp = {
    send: async () => ({ metrics: [{ name: "TaskDuration", value: taskMs / 1000 }] }),
  } as unknown as CDPSession;

  const result = await navigateCriticalPath(page, cdp, "cron", async () => {
    actions.push("profile");
  });

  expect(actions).toEqual(["profile", "pages", "cron"]);
  expect(result.startedMs).toBe(40);
  expect(result.elapsedMs).toBe(30);
  expect(result.cpuMilliseconds.TaskDuration).toBe(50);
  expect(result.rpcs.map((entry) => entry.method)).toEqual(["cron.list"]);
  expect(result.navigation.startedMs).toBe(10);
  expect(result.navigation.cpuMilliseconds.TaskDuration).toBe(80);
  expect(result.navigation.documentRpcsCapturedMs).toBe(95);
  expect(result.navigation.documentRpcs.map((entry) => entry.method)).toEqual([
    "connect",
    "sessions.list",
    "cron.list",
  ]);
});
