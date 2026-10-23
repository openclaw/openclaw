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
