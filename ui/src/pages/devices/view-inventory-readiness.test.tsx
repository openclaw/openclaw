/* @vitest-environment jsdom */

import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createDevicesViewProps } from "../../test-helpers/devices-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DeviceInventory } from "./view-inventory-readiness.tsx";

afterEach(cleanupSolid);

it("keeps preloaded rows out of the temporary readiness fallback", async () => {
  const completion = createDeferred();
  const props = createDevicesViewProps({
    nodes: [{ nodeId: "office", displayName: "Office Mac" }],
  });
  const { container } = mountSolid(() => {
    const read = createMemo(() => completion.promise);
    return <DeviceInventory {...props} inventoryRead={read} />;
  });
  flush();
  expect(container.querySelector(".device-entry__menu-trigger")).toBeNull();
  completion.resolve();
  await waitForSolid(() => expect(container.textContent).toContain("Office Mac"));
});

it("shows an empty inventory refresh as one skeleton after initial readiness", async () => {
  const props = createDevicesViewProps({ nodes: [], devicesList: { paired: [], pending: [] } });
  let hold = (_completion: Promise<void>) => {};
  const { container } = mountSolid(() => {
    const [completion, setCompletion] = createSignal(Promise.resolve());
    hold = (value) => {
      void setCompletion(value);
    };
    const read = createMemo(() => completion());
    return <DeviceInventory {...props} inventoryRead={read} />;
  });
  await waitForSolid(() =>
    expect(container.querySelector(".settings-loading-skeleton")).toBeNull(),
  );
  const completion = createDeferred();
  hold(completion.promise);
  await waitForSolid(() =>
    expect(container.querySelectorAll(".settings-loading-skeleton")).toHaveLength(1),
  );
  completion.resolve();
  await waitForSolid(() =>
    expect(container.querySelector(".settings-loading-skeleton")).toBeNull(),
  );
});

it("retains inventory content while retrying a failed read", async () => {
  const failed = createDeferred();
  const retry = createDeferred();
  let replaceRead = (_completion: Promise<void>) => {};
  const props = createDevicesViewProps({
    nodes: [{ nodeId: "office", displayName: "Office Mac" }],
    onReloadInventory: () => replaceRead(retry.promise),
  });
  const { container } = mountSolid(() => {
    const [completion, setCompletion] = createSignal(failed.promise);
    replaceRead = (value) => void setCompletion(value);
    const read = createMemo(() => completion());
    return <DeviceInventory {...props} inventoryRead={read} />;
  });
  failed.reject(new Error("Synthetic inventory failure"));
  await waitForSolid(() => expect(container.textContent).toContain("Synthetic inventory failure"));
  const button = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  button.click();
  flush();
  expect(container.textContent).toContain("Office Mac");
  expect(container.textContent).toContain("Synthetic inventory failure");
  retry.resolve();
  await waitForSolid(() => expect(container.querySelector('[role="alert"]')).toBeNull());
  expect(container.textContent).toContain("Office Mac");
});
