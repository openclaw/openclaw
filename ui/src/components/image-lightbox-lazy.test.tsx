/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { ImageLightbox } from "./image-lightbox.tsx";

const loading = vi.hoisted(() => {
  const { promise, resolve: release } = Promise.withResolvers<void>();
  return { promise, release: () => release() };
});
vi.mock("./image-lightbox-content.tsx", async (original) => {
  await loading.promise;
  return original();
});

it("loads only when opened, reads current media, and leaves a retired host empty", async () => {
  const restoreDialog = installDialogPolyfill();
  onTestFinished(restoreDialog);
  onTestFinished(loading.release);
  const current = mountSolid(() => <ImageLightbox src="before.png" imageTitle="Before" />);
  const retired = mountSolid(() => <ImageLightbox src="retired.png" />);
  const host = current.container.querySelector("openclaw-image-lightbox")!;
  const removed = retired.container.querySelector("openclaw-image-lightbox")!;
  expect(host.querySelector("openclaw-modal-dialog")).toBeNull();
  host.src = "after.png";
  host.imageTitle = "After";
  retired.unmount();
  flush();
  loading.release();
  await getRenderedModalDialog(host);
  expect(host.querySelector("img")?.getAttribute("src")).toBe("after.png");
  expect(host.querySelector("img")?.getAttribute("alt")).toBe("After");
  expect(removed.querySelector("openclaw-modal-dialog")).toBeNull();
});
