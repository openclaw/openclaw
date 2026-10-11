import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { SolidPanelController, usePanelController } from "./solid-panel-controller.ts";

it("keeps panel state synchronous and resolves its render fence after the DOM commit", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  let panel!: SolidPanelController & { value: number };
  const lifecycle: string[] = [];
  const mounted = mountSolid(
    () => {
      panel = Object.assign(new SolidPanelController(container), {
        value: 0,
      });
      panel.addController({
        hostConnected: () => lifecycle.push("connected"),
        hostUpdate: () => lifecycle.push("prepare"),
        hostUpdated: () => lifecycle.push("commit"),
        hostDisconnected: () => lifecycle.push("disconnected"),
      });
      usePanelController(panel);
      return <output>{panel.read().value}</output>;
    },
    { container },
  );
  flush();
  await panel.updateComplete;
  expect(panel.isConnected).toBe(true);
  expect(lifecycle[0]).toBe("connected");
  expect(mounted.container.textContent).toBe("0");
  panel.value = 7;
  panel.invalidate();
  expect(panel.value).toBe(7);
  expect(mounted.container.textContent).toBe("0");
  const committed = panel.updateComplete;
  flush();
  await committed;
  expect(mounted.container.textContent).toBe("7");
  expect(lifecycle.indexOf("prepare")).toBeLessThan(lifecycle.indexOf("commit"));
  mounted.unmount();
  container.remove();
  expect(lifecycle.filter((phase) => phase === "connected")).toHaveLength(1);
  expect(lifecycle.at(-1)).toBe("disconnected");
  expect(panel.isConnected).toBe(false);
});

it("commits an update requested by the panel's committed-DOM callback", async () => {
  const container = document.createElement("section");
  document.body.append(container);
  const panel = Object.assign(new SolidPanelController(container), { value: 0 });
  panel.updated = () => {
    if (panel.value === 1) {
      panel.value = 2;
      panel.invalidate();
    }
  };
  const mounted = mountSolid(
    () => {
      usePanelController(panel);
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
  const panel = Object.assign(new SolidPanelController(container), { value: 0 });
  const mounted = mountSolid(
    () => {
      usePanelController(panel);
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
