import { cleanup, render } from "@solidjs/testing-library";
import { Show, createEffect, createSignal, flush, onSettled } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { SettingsPage, SettingsPageHeader } from "../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../components/solid/settings-workspace.tsx";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { renderModelProvidersPageShell } from "../pages/model-providers/view.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
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

it("reserves the Models page column before its body finishes loading", () => {
  const content = document.createElement("main");
  content.className = "content";
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  const [loaded, setLoaded] = createSignal(false);
  render(
    () => (
      <ShellLayoutProvider value={{ owner, host: content }}>
        {renderModelProvidersPageShell({
          get body() {
            return (
              <Show when={loaded()} fallback={<span>Loading models</span>}>
                <SettingsPage>Models ready</SettingsPage>
              </Show>
            );
          },
          login: undefined,
        })}
      </ShellLayoutProvider>
    ),
    { container: content },
  );
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(content.textContent).toContain("Loading models");
  setLoaded(true);
  flush();
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(content.textContent).toContain("Models ready");
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

const BridgedSettingsPage = defineSolidBridge(
  "openclaw-layout-test-page",
  () => (
    <SettingsPage wide>
      <SettingsPageHeader title="Native settings" />
    </SettingsPage>
  ),
  { properties: {} },
);

it.each([
  { bridged: false, detached: false },
  { bridged: true, detached: false },
  { bridged: true, detached: true },
])(
  "publishes initial page layout ($bridged bridge, $detached detached)",
  async ({ bridged, detached }) => {
    const owner = new ShellLayoutOwner();
    let content!: HTMLElement;
    const container = detached ? document.createElement("div") : undefined;
    mountSolid(
      () => (
        <main
          class="content"
          ref={(element) => {
            content = element;
            owner.contentRef(element);
          }}
        >
          <ShellLayoutProvider
            value={{
              owner,
              get host() {
                return content;
              },
            }}
          >
            {bridged ? (
              <BridgedSettingsPage />
            ) : (
              <SettingsPage wide>
                <SettingsPageHeader title="Native settings" />
              </SettingsPage>
            )}
          </ShellLayoutProvider>
        </main>
      ),
      { container },
    );
    if (container) {
      await Promise.resolve();
      document.body.append(container);
    }
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    expect(content.classList.contains("content--settings-page")).toBe(true);
    expect(content.classList.contains("content--settings-wide")).toBe(true);
    expect(content.classList.contains("content--toolbar-header")).toBe(true);
  },
);
