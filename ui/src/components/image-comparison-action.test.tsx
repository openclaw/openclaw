/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { ImageComparisonAction } from "./image-comparison-action.tsx";

const dialog = vi.hoisted(() => ({
  loading: Promise.withResolvers<void>(),
  show: vi.fn(async () => {}),
}));
vi.mock("./image-comparison-dialog.tsx", async () => {
  await dialog.loading.promise;
  return { ImageComparison: () => null, showImageComparison: dialog.show };
});

it("retires changed selections during loading but preserves same-image rendition upgrades", async () => {
  onTestFinished(() => dialog.loading.resolve());
  const first = { readOriginalBlob: vi.fn(async () => new Blob()) };
  const next = { readOriginalBlob: vi.fn(async () => new Blob()) };
  const [image, setImage] = createSignal(first);
  const [index, setIndex] = createSignal(0);
  const retired = mountSolid(() => (
    <ImageComparisonAction
      image={image()}
      source="gallery.png"
      index={index()}
      title="Selected"
      disabled={false}
      focusableRef={() => () => {}}
    />
  ));
  const current = mountSolid(() => (
    <ImageComparisonAction
      image={image()}
      source="gallery.png"
      index={0}
      title="Unchanged"
      disabled={false}
      focusableRef={() => () => {}}
    />
  ));
  retired.getByRole("button").click();
  current.getByRole("button").click();
  setImage(next);
  setIndex(1);
  flush();
  dialog.loading.resolve();
  await waitForSolid(() => expect(dialog.show).toHaveBeenCalled());
  expect(dialog.show.mock.calls.map((call) => call.slice(0, 2))).toEqual([
    [first.readOriginalBlob, "Unchanged"],
  ]);
  retired.getByRole("button").click();
  await waitForSolid(() => expect(dialog.show).toHaveBeenCalledTimes(2));
  expect(dialog.show.mock.calls[1]?.slice(0, 2)).toEqual([next.readOriginalBlob, "Selected"]);
});
