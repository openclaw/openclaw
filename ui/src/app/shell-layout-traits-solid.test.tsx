import { cleanup, render } from "@solidjs/testing-library";
import { Show, createEffect, createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { SettingsPage, SettingsPageHeader } from "../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../components/solid/settings-workspace.tsx";
import { ShellLayoutOwner } from "./shell-layout-owner.ts";
import { ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

it("renders standalone settings without a shell layout owner", () => {
  const view = render(() => (
    <SettingsWorkspace>
      <SettingsPage>
        <SettingsPageHeader title="Standalone settings" />
      </SettingsPage>
    </SettingsWorkspace>
  ));
  expect(view.getByRole("heading", { name: "Standalone settings" })).toBeTruthy();
});

it("publishes settings layout before descendants render and measure updates", () => {
  const content = document.createElement("main");
  content.className = "content";
  const host = document.createElement("div");
  content.append(host);
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  const [wide, setWide] = createSignal(true);
  const observations: string[] = [];
  function Measure() {
    observations.push(content.className);
    createEffect(wide, () => {
      observations.push(content.className);
    });
    return <span>Measured</span>;
  }
  render(
    () => (
      <ShellLayoutProvider value={{ owner, host }}>
        <SettingsWorkspace>
          <SettingsPage wide={wide()}>
            <SettingsPageHeader title="Settings" />
            <Measure />
          </SettingsPage>
        </SettingsWorkspace>
      </ShellLayoutProvider>
    ),
    { container: host },
  );
  expect(observations[0]).toContain("content--settings-workspace");
  expect(observations[0]).toContain("content--settings-page");
  expect(observations[0]).toContain("content--settings-wide");
  expect(observations[0]).toContain("content--toolbar-header");
  setWide(false);
  flush();
  expect(observations.at(-1)).not.toContain("content--settings-wide");
  expect(content.classList.contains("content--settings-page")).toBe(true);
  cleanup();
  expect(content.className).toBe("content");
});

it("retires only the departing Solid reporter and preserves retained sibling facts", () => {
  const content = document.createElement("main");
  content.className = "content";
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  const [shown, setShown] = createSignal(true);
  render(
    () => (
      <ShellLayoutProvider value={{ owner, host: content }}>
        <Show when={shown()}>
          <SettingsPage wide>First</SettingsPage>
        </Show>
        <div hidden>
          <SettingsPage>Retained</SettingsPage>
        </div>
      </ShellLayoutProvider>
    ),
    { container: content },
  );
  setShown(false);
  flush();
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(content.classList.contains("content--settings-wide")).toBe(false);
  expect(content.querySelector("[hidden]")?.textContent).toBe("Retained");
});
