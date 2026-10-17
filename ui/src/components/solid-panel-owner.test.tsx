import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { SolidPanelOwner, usePanelOwner } from "./solid-panel-owner.ts";

it("keeps panel state synchronous and resolves its render fence after the DOM commit", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  let panel!: SolidPanelOwner & { value: number };
  const mounted = mountSolid(
    () => {
      panel = Object.assign(new SolidPanelOwner(container), {
        value: 0,
      });
      usePanelOwner(panel);
      return <output>{panel.read().value}</output>;
    },
    { container },
  );
  flush();
  await panel.updateComplete;
  expect(panel.isConnected).toBe(true);
  expect(mounted.container.textContent).toBe("0");
  panel.value = 7;
  panel.invalidate();
  expect(panel.value).toBe(7);
  expect(mounted.container.textContent).toBe("0");
  const committed = panel.updateComplete;
  flush();
  await committed;
  expect(mounted.container.textContent).toBe("7");
  mounted.unmount();
  container.remove();
  expect(panel.isConnected).toBe(false);
});

it("commits an update requested by the panel's committed-DOM callback", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  const panel = Object.assign(new SolidPanelOwner(container), { value: 0 });
  panel.updated = () => {
    if (panel.value === 1) {
      panel.value = 2;
      panel.invalidate();
    }
  };
  const mounted = mountSolid(
    () => {
      usePanelOwner(panel);
      return <output>{panel.read().value}</output>;
    },
    { container },
  );
  await waitForSolid(() => expect(panel.hasUpdated).toBe(true));
  panel.value = 1;
  panel.invalidate();
  await waitForSolid(() => expect(container.textContent).toBe("2"));
  await expect(panel.updateComplete).resolves.toBe(true);
  mounted.unmount();
  container.remove();
});

it("settles a pending update when its view is disposed", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  const panel = Object.assign(new SolidPanelOwner(container), { value: 0 });
  const mounted = mountSolid(
    () => {
      usePanelOwner(panel);
      return <output>{panel.read().value}</output>;
    },
    { container },
  );
  flush();
  await panel.updateComplete;
  panel.value = 1;
  panel.invalidate();
  const pending = panel.updateComplete;
  mounted.unmount();
  await expect(pending).resolves.toBe(false);
  container.remove();
});
