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

function clientFor(
  action: (method: string) => Promise<unknown>,
  status = initialStatus,
): GatewayBrowserClient {
  // SAFETY: This view fixture exercises only the browser client request boundary.
  return {
    request: vi.fn(async (method: string, params: { day: string }) => {
      return method === "logbook.status"
        ? status
        : method === "logbook.timeline"
          ? logbookTimeline(params.day)
          : action(method);
    }),
  } as unknown as GatewayBrowserClient;
}

it.each([
  { paused: false, reject: false },
  { paused: false, reject: true },
  { paused: true, reject: false },
  { paused: true, reject: true },
])(
  "reports pending capture before acknowledgement (paused=$paused, reject=$reject)",
  async ({ paused, reject }) => {
    const status = { ...initialStatus, capturePaused: paused };
    const pending = Promise.withResolvers<LogbookStatusPayload>();
    onTestFinished(() => pending.resolve(status));
    const client = clientFor(() => pending.promise, status);
    const view = mountSolid(() => (
      <Logbook initialClient={client} getRetired={() => neverRetired} />
    ));
    const before = paused ? "Resume capture" : "Pause capture";
    const after = paused ? "Pause capture" : "Resume capture";
    await waitForSolid(() => expect(view.queryByRole("button", { name: before })).not.toBeNull());
    const button = view.getByRole("button", { name: before });
    button.click();
    await waitForSolid(() => expect(button.textContent).toBe(after));
    const chip = () => view.container.querySelector(".logbook__chip")?.textContent?.trim();
    expect.soft(chip()).toBe(paused ? "Resuming capture…" : "Pausing capture…");
    if (reject) {
      pending.reject(new Error("Capture change rejected."));
    } else {
      pending.resolve({ ...status, capturePaused: !paused });
    }
    await waitForSolid(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(view.getByRole("button", { name: reject ? before : after })).toBe(button);
    expect(chip()).toBe((reject ? paused : !paused) ? "Capture paused" : "Capturing every 30s");
    if (reject) {
      expect(view.getByRole("alert").textContent).toContain("Capture change rejected.");
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
    await waitForSolid(() =>
      expect(view.queryByRole("button", { name: "Pause capture" })).not.toBeNull(),
    );
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
