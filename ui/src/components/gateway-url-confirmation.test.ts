/* @vitest-environment jsdom */
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid } from "../test-helpers/mount-solid.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { GatewayUrlConfirmation } from "./solid/gateway-url-confirmation.tsx";

const modalModule = vi.hoisted(() => ({ load: vi.fn() }));

// mock-isolation: Observe the native modal registration boundary without its renderer.
vi.mock("./modal-dialog.ts", () => {
  modalModule.load();
  customElements.define("openclaw-modal-dialog", class extends HTMLElement {});
  return {};
});

afterEach(cleanupSolid);

it("loads the modal only for a pending gateway and retains its confirmation actions", async () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  const view = mountSolid<Parameters<typeof GatewayUrlConfirmation>[0]>(GatewayUrlConfirmation, {});
  const host = view.container;
  const show = (pendingGatewayUrl: string | null) => {
    view.update({
      props: {
        pendingGatewayUrl,
        currentGatewayUrl: "https://current.example",
        linkCarriesToken: false,
        onConfirm: confirm,
        onCancel: cancel,
      },
    });
  };

  show(null);
  expect(modalModule.load).not.toHaveBeenCalled();
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();

  show("https://next.example");
  await vi.dynamicImportSettled();
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
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
});
