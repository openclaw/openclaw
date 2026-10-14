import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createBrowserClient } from "./browser-panel-controller-test-support.ts";
import "./browser-panel.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["success", "failure"] as const)(
  "shows pending browser startup and recovers after %s",
  async (outcome) => {
    const start = createDeferred();
    const requested = createDeferred();
    let starts = 0;
    let running = false;
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = createBrowserClient(async ({ path }) => {
      if (path === "/tabs") {
        return { running, tabs: [] };
      }
      if (path === "/start") {
        starts += 1;
        requested.resolve();
        if (starts === 1) {
          await start.promise;
        }
        running = true;
        return {};
      }
      throw new Error(`Unexpected browser route: ${path}`);
    }).client;
    const mounted = mountSolid(() => panel);
    const startButton = () => mounted.getByRole("button", { name: "Start browser" });
    try {
      await waitForSolid(() => expect(startButton().hasAttribute("disabled")).toBe(false));
      startButton().click();
      await requested.promise;
      await waitForSolid(() => {
        expect(mounted.getByRole("status", { name: "Loading page…" })).toBeTruthy();
        expect(mounted.queryByRole("button", { name: "Start browser" })).toBeNull();
        expect(panel.textContent).not.toContain("The gateway browser is not running.");
      });
      expect(starts).toBe(1);

      if (outcome === "failure") {
        start.reject(new Error("Synthetic startup failure"));
        await waitForSolid(() => {
          expect(mounted.getByRole("alert").textContent).toContain("Synthetic startup failure");
          expect(startButton().hasAttribute("disabled")).toBe(false);
          expect(mounted.queryByRole("status", { name: "Loading page…" })).toBeNull();
        });
        startButton().click();
      } else {
        start.resolve();
      }
      await waitForSolid(() => {
        expect(panel.textContent).toContain("A shared browser for you and the agent.");
        expect(mounted.queryByRole("button", { name: "Start browser" })).toBeNull();
        expect(mounted.queryByRole("status", { name: "Loading page…" })).toBeNull();
        expect(mounted.queryByRole("alert")).toBeNull();
      });
      expect(starts).toBe(outcome === "failure" ? 2 : 1);
    } finally {
      start.resolve();
    }
  },
);
