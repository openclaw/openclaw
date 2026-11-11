/* @vitest-environment jsdom */

import { createSignal, Show } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { LogbookStatusPayload } from "./logbook-types.ts";
import { Logbook } from "./logbook-view.tsx";
import { logbookStatus, logbookTimeline } from "./logbook.test-support.ts";
const neverRetired = new Promise<void>(() => {});

afterEach(cleanupSolid);

const initialStatus = logbookStatus("2026-01-01", { todayCards: 0 });

function clientFor(action: (method: string) => Promise<unknown>): GatewayBrowserClient {
  // SAFETY: This view fixture exercises only the browser client request boundary.
  return {
    request: vi.fn(async (method: string, params: { day: string }) => {
      return method === "logbook.status"
        ? initialStatus
        : method === "logbook.timeline"
          ? logbookTimeline(params.day)
          : action(method);
    }),
  } as unknown as GatewayBrowserClient;
}

it.each([false, true])(
  "shows a capture guess and reconciles a rejected=%s write",
  async (reject) => {
    const pending = Promise.withResolvers<LogbookStatusPayload>();
    onTestFinished(() => pending.resolve(initialStatus));
    const client = clientFor(() => pending.promise);
    const view = mountSolid(() => (
      <Logbook initialClient={client} getRetired={() => neverRetired} />
    ));
    await waitForSolid(() => expect(view.queryByRole("button", { name: "Pause" })).not.toBeNull());
    const button = view.getByRole("button", { name: "Pause" });
    button.click();
    await waitForSolid(() => expect(button.textContent).toBe("Resume"));
    expect(view.getByRole("button", { name: "Resume" })).toBe(button);
    if (reject) {
      pending.reject(new Error("Capture could not be paused."));
    } else {
      pending.resolve({ ...initialStatus, capturePaused: true });
    }
    await waitForSolid(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(button.textContent).toBe(reject ? "Pause" : "Resume");
    if (reject) {
      expect(view.getByRole("alert").textContent).toContain("Capture could not be paused.");
    }
  },
);

it.each(["standup", "ask", "analyze"] as const)(
  "retires a held %s action before replacing its view",
  async (kind) => {
    const pending = Promise.withResolvers<unknown>();
    const retired = Promise.withResolvers<void>();
    onTestFinished(() => pending.resolve({}));
    let leave = () => {};
    const client = clientFor(() => pending.promise);
    const view = mountSolid(() => {
      const [visible, setVisible] = createSignal(true);
      leave = () => {
        retired.resolve();
        setVisible(false);
      };
      return (
        <Show when={visible()} fallback={<p>Destination</p>}>
          <Logbook initialClient={client} getRetired={() => retired.promise} />
        </Show>
      );
    });
    await waitForSolid(() => expect(view.queryByRole("button", { name: "Pause" })).not.toBeNull());
    if (kind === "ask") {
      const input = view.getByRole("textbox") as HTMLInputElement;
      input.value = "What changed today?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    }
    const button = view.getByRole("button", {
      name: kind === "standup" ? "Generate" : kind === "ask" ? "Ask" : "Analyze now",
    });
    button.click();
    await waitForSolid(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    leave();
    await waitForSolid(() => expect(view.container.textContent).toBe("Destination"));
    pending.reject(new Error("Retired operation failed."));
    await Promise.resolve();
    expect(view.container.textContent).toBe("Destination");
  },
);
