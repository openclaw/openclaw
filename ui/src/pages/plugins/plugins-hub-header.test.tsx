// @vitest-environment jsdom
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginsHubHeader } from "./plugins-hub-header.tsx";
import type { PluginsHubTab } from "./plugins-hub.ts";

function templatesFlag(templates: boolean) {
  const context = {
    runtimeConfig: {
      state: {
        configForm: null,
        configSnapshot: { config: { gateway: { controlUi: { experimental: { templates } } } } },
      },
      subscribe: () => () => undefined,
    },
  } as unknown as ApplicationContext;
  return {
    wrapper: (props: { children: JSX.Element }) => (
      <ApplicationProvider value={context}>{props.children}</ApplicationProvider>
    ),
  };
}

it("lists Templates as a Customize tab only while its experimental flag is on", () => {
  const tabs = (templates: boolean) =>
    mountSolid(
      () => <PluginsHubHeader active="plugins" onSelect={() => {}} />,
      templatesFlag(templates),
    )
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
  expect(tabs(true)).toEqual(["Plugins", "Skills", "Skill workshop", "Templates"]);
  expect(tabs(false)).toEqual(["Plugins", "Skills", "Skill workshop"]);
});

it("keeps Plugins hub tabs and actions live in the shared hub header", () => {
  const [active, setActive] = createSignal<PluginsHubTab>("plugins");
  const onSelect = vi.fn();
  const onSettings = vi.fn();
  const view = mountSolid(
    () => (
      <PluginsHubHeader
        active={active()}
        onSelect={onSelect}
        secondaryAction={{ label: "Manage plugins", onClick: onSettings }}
      />
    ),
    templatesFlag(false),
  );

  expect(view.container.querySelector(".plugins-hub-header.hub-page-header h1")?.textContent).toBe(
    "Plugins",
  );
  view.getByRole("tab", { name: "Skills" }).click();
  expect(onSelect).toHaveBeenCalledWith("skills");
  view.getByRole("button", { name: "Manage plugins" }).click();
  expect(onSettings).toHaveBeenCalledOnce();

  setActive("skills");
  flush();
  expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Skills");
  expect(view.getByRole("tab", { name: "Skills" }).getAttribute("aria-selected")).toBe("true");
  expect(view.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
    "https://docs.openclaw.ai/tools/skills",
  );
});

it("restores keyboard focus to the destination tab when its route replaces the header", async () => {
  const [active, setActive] = createSignal<PluginsHubTab>("skills");
  const view = mountSolid(
    () => (
      <Show when={active()} keyed>
        {(tab) => <PluginsHubHeader active={tab} onSelect={setActive} />}
      </Show>
    ),
    templatesFlag(false),
  );
  const workshop = view.getByRole("tab", { name: "Skill workshop" });
  workshop.focus();
  workshop.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  await waitForSolid(() => {
    const destination = view.getByRole("tab", { name: "Skill workshop" });
    expect(destination).not.toBe(workshop);
    expect(destination.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(destination);
  });
});
