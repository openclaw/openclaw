import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { HubTabs } from "./solid/hub-tabs.tsx";
import "../styles/base.css";
import "../styles/agents.css";

it.each(["primary", "sub"] as const)(
  "keeps %s hub tabs at their natural height above a flexing panel",
  async (variant) => {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;width:240px";
    document.body.append(root);
    onTestFinished(() => root.remove());
    mountSolid(
      () => (
        <>
          <HubTabs
            id="bounded"
            active="sessions"
            tabs={[
              { value: "sessions", label: "Sessions" },
              { value: "live", label: "Live activity" },
            ]}
            ariaLabel="Activity view"
            panelId="bounded-panel"
            variant={variant}
            onSelect={vi.fn()}
          />
          <div id="bounded-panel" style={{ flex: "1 1 auto", "min-height": "0" }}>
            <div style={{ height: "600px" }}>Activity content</div>
          </div>
        </>
      ),
      { container: root },
    );
    await waitForSolid(() => expect(root.querySelector("[role=tablist]")).not.toBeNull());
    const tabs = root.querySelector<HTMLElement>("[role=tablist]")!;
    const naturalHeight = tabs.getBoundingClientRect().height;
    expect(naturalHeight).toBeGreaterThan(24);

    root.style.height = "180px";
    expect(tabs.getBoundingClientRect().height).toBe(naturalHeight);
    expect(
      root.querySelector("#bounded-panel")!.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(root.getBoundingClientRect().bottom);
  },
);

it("shrinks row-hosted tabs to keep the trailing Add File control inside the panel", async () => {
  const root = document.createElement("div");
  root.className = "agent-file-tabs";
  root.style.width = "280px";
  document.body.append(root);
  onTestFinished(() => root.remove());
  mountSolid(
    () => (
      <>
        <HubTabs
          id="agent-files"
          active="agents"
          tabs={[
            { value: "agents", label: "AGENTS" },
            { value: "heartbeat", label: "HEARTBEAT", badge: "Missing" },
            { value: "identity", label: "IDENTITY", badge: "Missing" },
          ]}
          ariaLabel="Core files"
          panelId="agent-file-panel"
          variant="sub"
          onSelect={vi.fn()}
        />
        <select class="agent-tab-add" aria-label="Add File">
          <option>Add File</option>
          <option>MEMORY</option>
        </select>
      </>
    ),
    { container: root },
  );
  await waitForSolid(() => expect(root.querySelector("[role=tablist]")).not.toBeNull());
  const tabs = root.querySelector<HTMLElement>("[role=tablist]")!;
  const control = root.querySelector("select")!;
  const panelBounds = root.getBoundingClientRect();
  const tabBounds = tabs.getBoundingClientRect();
  const controlBounds = control.getBoundingClientRect();
  expect(tabBounds.right).toBeLessThanOrEqual(controlBounds.left);
  expect(controlBounds.right).toBeLessThanOrEqual(panelBounds.right);
  expect(tabBounds.width).toBeLessThan(panelBounds.width);
  expect(tabs.scrollWidth).toBeGreaterThan(tabs.clientWidth);
});

it("restores keyboard focus when navigation replaces a Solid tab strip", async () => {
  const root = document.createElement("div");
  const destination = document.createElement("div");
  document.body.append(root);
  onTestFinished(() => root.remove());
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
  mountSolid(
    () => (
      <HubTabs
        id="mixed"
        active="skills"
        tabs={tabs}
        ariaLabel="Sections"
        panelId="mixed-panel"
        onSelect={onSelect}
      />
    ),
    { container: destination },
  );
  await expect.poll(() => document.activeElement?.id).toBe("mixed-tab-skills");
});
