import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiAction,
  ControlUiActionReceipt,
  ControlUiHost,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { ChatRunFailureNotice } from "../pages/chat/components/chat-run-failure-notice.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import type { ControlUiRegistration } from "./control-ui-capability.ts";
import { createInertViewHost } from "./control-ui-view.test-support.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture(sessionKey = "agent:main:proof") {
  const abort = new AbortController();
  const request = vi.fn<ControlUiHost["request"]>().mockResolvedValue({ ok: true });
  let receipt: ControlUiActionReceipt | undefined;
  let hidden = false;
  const resolve = vi.fn(() => ({ hidden, receipt }));
  const run = vi.fn<ControlUiAction["run"]>(async ({ host }) => {
    await host.request("plugins.sessionAction", { pluginId: "synthetic", actionId: "report" });
    receipt = {
      id: "receipt-42",
      text: "Recorded <script>plain text</script>",
      links: [
        { label: "Open report", url: "https://example.test/report/42" },
        { label: "Unsafe", url: "javascript:alert(1)" },
      ],
    };
    invalidate();
  });
  const entry: ControlUiRegistration<ControlUiAction> = {
    key: "synthetic/report",
    pluginId: "synthetic",
    signal: abort.signal,
    host: { ...createInertViewHost(abort.signal), request },
    value: { id: "report", label: "Report with plugin", placement: "run-failure", resolve, run },
  };
  const listeners = new Set<() => void>();
  const plugins = {
    revision: 0,
    registrations: () => (abort.signal.aborted ? [] : [entry]),
    reportError: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  function invalidate() {
    plugins.revision++;
    listeners.forEach((listener) => listener());
  }
  // SAFETY: this leaf reads only the plugin contribution capability.
  const provider = createSolidApplicationContextProvider({
    plugins,
  } as unknown as ApplicationContext);
  const view = mountSolid(
    () => (
      <ChatRunFailureNotice
        sessionKey={sessionKey}
        agentId="main"
        runId="terminal-run"
        summary="The final provider failed."
      />
    ),
    { wrapper: provider.wrapper },
  );
  cleanups.push(view.unmount);
  flush();
  return {
    ...view,
    request,
    resolve,
    run,
    invalidate,
    hide: () => {
      hidden = true;
      invalidate();
    },
    disable: () => {
      abort.abort();
      invalidate();
    },
  };
}

it("uses the built-in report link without a plugin and when its action is hidden or removed", () => {
  const alone = mountSolid(() => <ChatRunFailureNotice summary="Failure" />);
  cleanups.push(alone.unmount);
  expect(alone.container.textContent).toContain("Report a bug");
  const view = fixture();
  expect(view.container.textContent).toContain("Report with plugin");
  view.hide();
  flush();
  expect(view.container.textContent).toContain("Report a bug");
  view.disable();
  flush();
  expect(view.container.textContent).toContain("Report a bug");
});

it("passes settled facts and renders an attributed virtual receipt without a chat/model request", async () => {
  const view = fixture();
  expect(view.request).not.toHaveBeenCalled();
  expect(view.resolve).toHaveBeenCalledWith({
    sessionKey: "agent:main:proof",
    agentId: "main",
    runFailure: { runId: "terminal-run", summary: "The final provider failed.", cause: undefined },
  });
  view.container.querySelector<HTMLButtonElement>("button.btn")!.click();
  await vi.waitFor(() =>
    expect(view.container.querySelector("[data-plugin-receipt]")).not.toBeNull(),
  );
  expect(view.request.mock.calls.map(([method]) => method)).toEqual(["plugins.sessionAction"]);
  const receipt = view.container.querySelector("[data-plugin-receipt]")!;
  expect(receipt.textContent).toContain("synthetic · receipt-42");
  expect(receipt.textContent).toContain("<script>plain text</script>");
  expect(receipt.querySelector("script")).toBeNull();
  expect(receipt.querySelectorAll("a")).toHaveLength(1);
  expect(receipt.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
});

it("shows a denied plugin request without fabricating a receipt and restores the report fallback", async () => {
  const view = fixture();
  view.request.mockRejectedValueOnce(new Error("Forbidden session"));
  view.container.querySelector<HTMLButtonElement>("button.btn")!.click();
  await vi.waitFor(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("Forbidden session"),
  );
  expect(view.container.querySelector("[data-plugin-receipt]")).toBeNull();
  expect(view.container.textContent).toContain("Report a bug");
});

it("does not disclose incognito failure content to a plugin resolver", () => {
  const view = fixture("agent:main:dashboard:incognito-private");
  expect(view.resolve).not.toHaveBeenCalled();
  expect(view.container.querySelector(".report-issue-link")).not.toBeNull();
  expect(view.run).not.toHaveBeenCalled();
});
