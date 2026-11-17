import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type {
  ControlUiAction,
  ControlUiActionReceipt,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { ChatRunFailureNotice } from "../pages/chat/components/chat-run-failure-notice.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { createInertViewHost } from "./control-ui-view.test-support.ts";
import "../test-helpers/load-styles.ts";

it("shows native plugin receipt content below a failed run and preserves the default without a plugin", async () => {
  await page.viewport(900, 340);
  const [enabled, setEnabled] = createSignal(false);
  let receipt: ControlUiActionReceipt | undefined;
  const listeners = new Set<() => void>();
  const request = vi.fn(async () => ({ ok: true }));
  const abort = new AbortController();
  const plugins = {
    revision: 0,
    registrations: () =>
      enabled()
        ? [
            {
              key: "diagnostics/report",
              pluginId: "diagnostics",
              signal: abort.signal,
              host: { ...createInertViewHost(abort.signal), request },
              value: action,
            },
          ]
        : [],
    reportError: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const action: ControlUiAction = {
    id: "report",
    label: "Report with diagnostics",
    placement: "run-failure",
    resolve: () => ({ receipt }),
    run: async () => {
      receipt = {
        id: "DEMO-42",
        text: "Diagnostic report saved.",
        links: [{ label: "View report", url: "https://example.test/reports/42" }],
      };
      plugins.revision++;
      listeners.forEach((listener) => listener());
    },
  };
  // SAFETY: the actual notice component consumes only this plugin capability.
  const provider = createSolidApplicationContextProvider({
    plugins,
  } as unknown as ApplicationContext);
  const view = mountSolid(
    () => (
      <div style={{ padding: "24px", width: "850px" }}>
        <ChatRunFailureNotice
          sessionKey="agent:demo:proof"
          agentId="demo"
          runId="demo-failed-run"
          summary="The provider could not complete this request after recovery."
          onRetry={() => undefined}
        />
      </div>
    ),
    { wrapper: provider.wrapper },
  );
  try {
    expect(view.container.querySelector(".report-issue-link")).not.toBeNull();
    console.info(
      "FAILURE_BEFORE",
      await page
        .elementLocator(view.container)
        .screenshot({ path: "../../../.openclaw/tmp/run-failure-before.png" }),
    );
    setEnabled(true);
    flush();
    await userEvent.click(page.getByRole("button", { name: "Report with diagnostics" }));
    await expect.element(page.getByText("Diagnostic report saved.")).toBeVisible();
    const notice = view.container.querySelector(".chat-run-failure")!;
    const receiptElement = view.container.querySelector("[data-plugin-receipt]")!;
    expect(receiptElement.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      notice.getBoundingClientRect().bottom,
    );
    expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
    const icon = receiptElement.querySelector("svg")!;
    expect(icon.getBoundingClientRect().width).toBeLessThanOrEqual(20);
    expect(icon.getBoundingClientRect().height).toBeLessThanOrEqual(20);
    await expect
      .element(page.getByRole("button", { name: "Report with diagnostics" }))
      .toBeEnabled();
    console.info(
      "FAILURE_AFTER",
      await page
        .elementLocator(view.container)
        .screenshot({ path: "../../../.openclaw/tmp/run-failure-after.png" }),
    );
  } finally {
    view.unmount();
  }
});
