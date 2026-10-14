/* @vitest-environment jsdom */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createShellOwner, mountShellView, settleShell } from "./app-host-solid.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { NAVIGATION_RAIL_WIDTH } from "./navigation-surface.ts";
import { loadSettings, settingsKeyForGateway } from "./settings.ts";

setupSidebarTest();

describe("sidebar preferences across tabs", () => {
  it.each([false, true])(
    "preserves another tab's agent pin when resizing (storage event delivered: %s)",
    async (deliverStorageEvent) => {
      vi.useFakeTimers();
      vi.stubGlobal("requestIdleCallback", vi.fn());
      const runtime = bootstrapApplication();
      const shell = createShellOwner();
      onTestFinished(() => {
        shell.disconnect();
        shell.element.remove();
        runtime.stop();
      });
      shell.runtime = runtime;
      document.body.append(shell.element);
      mountShellView(shell);
      shell.connect();
      await settleShell(shell);
      shell.routeState = { routeId: "chat" };
      await settleShell(shell);
      const frame = shell.querySelector<HTMLElement>(".shell");
      const divider = shell.querySelector<HTMLElement>(".sidebar-resizer");
      expect(frame).not.toBeNull();
      expect(divider).not.toBeNull();
      Object.defineProperty(frame, "clientWidth", { value: 1280 });

      const key = settingsKeyForGateway(runtime.context.gateway.connection.gatewayUrl);
      const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(
        key,
        JSON.stringify({ ...stored, navWidth: 360, pinnedAgentIds: ["research"] }),
      );
      if (deliverStorageEvent) {
        window.dispatchEvent(new StorageEvent("storage", { key }));
        await settleShell(shell);
        expect(runtime.context.navigation.snapshot.pinnedAgentIds).toEqual(["research"]);
        expect(frame!.style.getPropertyValue("--shell-nav-expanded-width")).toBe(
          `${360 + NAVIGATION_RAIL_WIDTH}px`,
        );
      }

      divider!.dispatchEvent(new CustomEvent("resize", { detail: { splitRatio: 0.25 } }));
      await settleShell(shell);

      expect(loadSettings()).toMatchObject({
        navWidth: 320 - NAVIGATION_RAIL_WIDTH,
        pinnedAgentIds: ["research"],
      });
      expect(runtime.context.navigation.snapshot.pinnedAgentIds).toEqual(["research"]);
      expect(frame!.style.getPropertyValue("--shell-nav-expanded-width")).toBe("320px");
    },
  );
});
