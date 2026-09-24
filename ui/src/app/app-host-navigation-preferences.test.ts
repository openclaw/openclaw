/* @vitest-environment jsdom */
import type { LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-host.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { loadSettings, settingsKeyForGateway } from "./settings.ts";

setupSidebarTest();

describe("sidebar preferences across tabs", () => {
  it.each([false, true])(
    "preserves another tab's agent pin when resizing (storage event delivered: %s)",
    async (deliverStorageEvent) => {
      vi.useFakeTimers();
      vi.stubGlobal("requestIdleCallback", vi.fn());
      const runtime = bootstrapApplication();
      const shell = document.createElement("openclaw-app-shell") as LitElement & {
        runtime: ApplicationRuntime;
        routeState: { routeId: "chat" };
      };
      onTestFinished(() => {
        shell.remove();
        runtime.stop();
      });
      shell.runtime = runtime;
      document.body.append(shell);
      await settleLitElement(shell);
      shell.routeState = { routeId: "chat" };
      await settleLitElement(shell);
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
        await settleLitElement(shell);
        expect(runtime.context.navigation.snapshot.pinnedAgentIds).toEqual(["research"]);
        expect(frame!.style.getPropertyValue("--shell-nav-expanded-width")).toBe("360px");
      }

      divider!.dispatchEvent(new CustomEvent("resize", { detail: { splitRatio: 0.25 } }));
      await settleLitElement(shell);

      expect(loadSettings()).toMatchObject({ navWidth: 320, pinnedAgentIds: ["research"] });
      expect(runtime.context.navigation.snapshot.pinnedAgentIds).toEqual(["research"]);
      expect(frame!.style.getPropertyValue("--shell-nav-expanded-width")).toBe("320px");
    },
  );
});
