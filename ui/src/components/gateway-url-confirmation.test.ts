/* @vitest-environment jsdom */
import { html, render } from "lit";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayUrlConfirmation } from "./gateway-url-confirmation.ts";

const modalModule = vi.hoisted(() => ({ load: vi.fn() }));

// mock-isolation: Observe the native modal registration boundary without its renderer.
vi.mock("./modal-dialog.ts", () => {
  modalModule.load();
  customElements.define("openclaw-modal-dialog", class extends HTMLElement {});
  return {};
});

afterEach(() => document.body.replaceChildren());

it("loads the modal only for a pending gateway and retains its confirmation actions", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const confirm = vi.fn();
  const cancel = vi.fn();
  const show = (pendingGatewayUrl: string | null) => {
    render(
      html`<openclaw-gateway-url-confirmation
        .props=${{
          pendingGatewayUrl,
          currentGatewayUrl: "https://current.example",
          linkCarriesToken: false,
          onConfirm: confirm,
          onCancel: cancel,
        }}
      ></openclaw-gateway-url-confirmation>`,
      container,
    );
    const host = container.firstElementChild;
    if (!(host instanceof GatewayUrlConfirmation.Element)) {
      throw new Error("Gateway confirmation did not upgrade");
    }
    return host;
  };

  const host = show(null);
  await host.updateComplete;
  expect(modalModule.load).not.toHaveBeenCalled();
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();

  show("https://next.example");
  await host.updateComplete;
  await vi.dynamicImportSettled();
  await host.updateComplete;
  flush();
  expect(modalModule.load).toHaveBeenCalledOnce();
  const modal = host.querySelector("openclaw-modal-dialog");
  expect(modal?.textContent).toContain("https://current.example");
  expect(modal?.textContent).toContain("https://next.example");
  const buttons = modal?.querySelectorAll("button");
  buttons?.[0]?.click();
  buttons?.[1]?.click();
  modal?.dispatchEvent(new CustomEvent("modal-cancel"));
  expect(confirm).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledTimes(2);

  show(null);
  await host.updateComplete;
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
});
