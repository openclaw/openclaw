import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { expect, it } from "vitest";
import { SolidPanelController, usePanelController } from "./solid-panel-controller.ts";

it("keeps panel state synchronous and resolves its render fence after the DOM commit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  let panel!: SolidPanelController & { value: number };
  const lifecycle: string[] = [];
  const dispose = render(() => {
    panel = Object.assign(new SolidPanelController(container), { value: 0 });
    panel.addController({
      hostConnected: () => lifecycle.push("connected"),
      hostUpdate: () => lifecycle.push("prepare"),
      hostUpdated: () => lifecycle.push("commit"),
      hostDisconnected: () => lifecycle.push("disconnected"),
    });
    usePanelController(panel);
    return <output>{panel.read().value}</output>;
  }, container);
  try {
    flush();
    await panel.updateComplete;
    expect(panel.isConnected).toBe(true);
    expect(lifecycle[0]).toBe("connected");
    expect(container.textContent).toBe("0");
    panel.value = 7;
    panel.requestUpdate("value", 0);
    expect(panel.value).toBe(7);
    expect(container.textContent).toBe("0");
    const committed = panel.updateComplete;
    flush();
    await committed;
    expect(container.textContent).toBe("7");
    expect(lifecycle.indexOf("prepare")).toBeLessThan(lifecycle.indexOf("commit"));
  } finally {
    dispose();
    container.remove();
  }
  expect(lifecycle.filter((phase) => phase === "connected")).toHaveLength(1);
  expect(lifecycle.at(-1)).toBe("disconnected");
  expect(panel.isConnected).toBe(false);
});
