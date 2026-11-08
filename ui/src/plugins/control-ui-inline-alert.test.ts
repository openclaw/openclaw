/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

it("renders a plugin failure as the host inline alert with collapsed details", async () => {
  const gateway = createGateway(
    createTestGatewayClient(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    }),
  );
  const context = createContext(gateway, createSessions("main", []), {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [],
  });
  const lifetime = new AbortController();
  const onError = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  const retry = vi.fn();
  const handle = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  }).mountInlineAlert(container, {
    tone: "danger",
    message: "Couldn’t load the pool. Try again.",
    detail: "503 upstream_unavailable",
    action: { label: "Retry", onSelect: retry },
  });

  await vi.dynamicImportSettled();
  await vi.waitFor(() => {
    expect(onError).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load the pool. Try again.",
    );
  });
  const details = container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Show details");
  expect(details?.textContent).toContain("503 upstream_unavailable");
  [...container.querySelectorAll("button")]
    .find((button) => button.textContent === "Retry")
    ?.click();
  expect(retry).toHaveBeenCalledOnce();

  handle.update({ tone: "info", message: "Saved." });
  await vi.waitFor(() => {
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved.");
  });
  expect(container.querySelector("details")).toBeNull();

  handle.dispose();
  expect(container.childElementCount).toBe(0);
});
