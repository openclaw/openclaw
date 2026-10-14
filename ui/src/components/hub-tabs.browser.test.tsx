import { nothing, render } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderHubTabs } from "./hub-tabs.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";

it("restores keyboard focus when navigation replaces a Solid tab strip with Lit", async () => {
  const root = document.createElement("div");
  const destination = document.createElement("div");
  document.body.append(root);
  onTestFinished(() => {
    render(nothing, destination);
    root.remove();
  });
  const onSelect = vi.fn();
  const tabs: Array<{ value: "plugins" | "skills"; label: string }> = [
    { value: "plugins", label: "Plugins" },
    { value: "skills", label: "Skills" },
  ];
  const source = mountSolid(
    () => (
      <HubTabs
        id="mixed"
        active="plugins"
        tabs={tabs}
        ariaLabel="Sections"
        panelId="mixed-panel"
        onSelect={onSelect}
      />
    ),
    { baseElement: root },
  );
  await waitForSolid(() => expect(root.querySelector("#mixed-tab-skills")).not.toBeNull());
  const target = root.querySelector<HTMLElement>("#mixed-tab-skills")!;
  target.focus();
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onSelect).toHaveBeenCalledWith("skills");

  source.unmount();
  root.append(destination);
  render(
    renderHubTabs({
      id: "mixed",
      active: "skills",
      tabs,
      ariaLabel: "Sections",
      panelId: "mixed-panel",
      onSelect,
    }),
    destination,
  );
  await expect.poll(() => document.activeElement?.id).toBe("mixed-tab-skills");
});
