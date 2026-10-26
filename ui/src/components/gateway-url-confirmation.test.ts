/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid } from "../test-helpers/mount-solid.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { GatewayUrlConfirmation } from "./solid/gateway-url-confirmation.tsx";

const modalModule = vi.hoisted(() => ({
  load: vi.fn(),
  first: Promise.withResolvers<void>(),
  second: Promise.withResolvers<void>(),
  recovery: Promise.withResolvers<void>(),
  canReload: (): boolean => false,
}));

// Keep the production renderer; hold and reject its actual cold-import boundary.
vi.mock("./modal-dialog.tsx", async (importOriginal) => {
  modalModule.load();
  if (modalModule.load.mock.calls.length === 1) {
    await modalModule.first.promise;
    throw new Error("Failed to fetch dynamically imported module");
  }
  await modalModule.second.promise;
  return importOriginal();
});
vi.mock("../app/stale-chunk-reload.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/stale-chunk-reload.ts")>();
  return {
    ...actual,
    // Vitest wraps rejected mock imports; browsers deliver the original import error.
    isStaleChunkImportError: (error: unknown) =>
      actual.isStaleChunkImportError(
        error instanceof Error && error.cause instanceof Error ? error.cause : error,
      ),
    retryStaleChunkReloadWhenReachable: async (options: { canReload: () => boolean }) => {
      modalModule.canReload = options.canReload;
      await modalModule.recovery.promise;
      return false;
    },
  };
});

afterEach(async () => {
  modalModule.first.resolve();
  modalModule.second.resolve();
  modalModule.recovery.resolve();
  cleanupSolid();
  await vi.dynamicImportSettled();
});

it("loads on demand, retries a failed import, and retires a pending modal without confirming", async () => {
  const confirm = vi.fn();
  const cancel = vi.fn();
  const view = mountSolid<Parameters<typeof GatewayUrlConfirmation>[0]>(GatewayUrlConfirmation, {});
  const host = view.container;
  const show = (pendingGatewayUrl: string | null) => {
    view.update({
      props: {
        pendingGatewayUrl,
        currentGatewayUrl: "https://current.example",
        linkCarriesToken: true,
        onConfirm: confirm,
        onCancel: cancel,
      },
    });
  };

  show(null);
  expect(modalModule.load).not.toHaveBeenCalled();
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
  show("https://next.example");
  await waitForSolid(() => {
    expect(modalModule.load).toHaveBeenCalledOnce();
    expect(host.querySelector("[role='status']")).not.toBeNull();
  });
  modalModule.first.resolve();
  await waitForSolid(() => expect(host.querySelector(".lazy-view-error--stale")).not.toBeNull());
  host.querySelector<HTMLButtonElement>(".lazy-view-error__action")!.click();
  expect(modalModule.canReload()).toBe(true);
  await waitForSolid(() => expect(host.querySelector("[role='status']")).not.toBeNull());
  modalModule.recovery.resolve();
  await waitForSolid(() => {
    expect(modalModule.load).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[role='status']")).not.toBeNull();
  });

  show(null);
  expect(modalModule.canReload()).toBe(false);
  modalModule.second.resolve();
  await vi.dynamicImportSettled();
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
  expect(confirm).not.toHaveBeenCalled();

  show("https://replacement.example");
  await waitForSolid(() => expect(host.querySelector("openclaw-modal-dialog")).not.toBeNull());
  const modal = host.querySelector("openclaw-modal-dialog")!;
  expect(modal.textContent).toContain("https://current.example");
  expect(modal.textContent).toContain("https://replacement.example");
  const buttons = Array.from(
    modal.querySelectorAll<HTMLButtonElement>(".gateway-switch__actions button"),
  );
  buttons.find((button) => button.textContent === "Keep current Gateway")!.click();
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  buttons.find((button) => button.textContent === "Switch to replacement.example")!.click();
  expect(confirm).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  modal.dispatchEvent(new CustomEvent("modal-cancel"));
  expect(cancel).toHaveBeenCalledTimes(2);

  show(null);
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
});
