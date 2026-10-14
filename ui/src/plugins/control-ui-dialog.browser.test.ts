import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { afterModalHidden } from "../test-helpers/modal-dialog.ts";
import { createControlUiComponents } from "./control-ui-components.ts";

it("keeps plugin dialog content and cancellation policy across handle updates", async () => {
  const gateway = createGateway(createTestGatewayClient(() => ({})));
  const context = createContext(gateway, createSessions("main", []));
  const lifetime = new AbortController();
  const onError = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  onTestFinished(() => {
    lifetime.abort();
    container.remove();
  });
  const components = createControlUiComponents({
    current: () => context,
    signal: lifetime.signal,
    onError,
  });
  const content = document.createElement("input");
  content.setAttribute("aria-label", "Draft");
  content.autofocus = true;
  const onCancel = vi.fn(() => true);
  const props = { label: "New card", content, onCancel };
  const handle = components.mountDialog(container, props);
  await vi.dynamicImportSettled();
  const modal = container.querySelector("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const dialog = modal.querySelector("dialog")!;
  expect(dialog.matches(":modal")).toBe(true);
  content.value = "Unsaved notes";

  const veto = vi.fn(() => false);
  handle.update({ ...props, label: "Saving card", onCancel: veto });
  await modal.updateComplete;
  expect(modal.querySelector("dialog")).toBe(dialog);
  expect(content.isConnected).toBe(true);
  expect(content.value).toBe("Unsaved notes");
  expect(dialog.getAttribute("aria-label")).toBe("Saving card");
  await userEvent.keyboard("{Escape}");
  expect(veto).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  expect(dialog.matches(":modal")).toBe(true);

  const replacement = document.createElement("textarea");
  replacement.value = "Replacement notes";
  handle.update({ ...props, content: replacement });
  await modal.updateComplete;
  expect(modal.querySelector("dialog")).toBe(dialog);
  expect(content.isConnected).toBe(false);
  expect(dialog.contains(replacement)).toBe(true);
  expect(replacement.value).toBe("Replacement notes");
  const hidden = afterModalHidden(modal);
  await userEvent.keyboard("{Escape}");
  await hidden;
  expect(onCancel).toHaveBeenCalledOnce();
  expect(dialog.open).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});
