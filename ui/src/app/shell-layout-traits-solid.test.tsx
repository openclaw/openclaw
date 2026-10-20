import { cleanup, render } from "@solidjs/testing-library";
import { Show, createEffect, createSignal, flush, onSettled } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { SettingsPage, SettingsPageHeader } from "../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../components/solid/settings-workspace.tsx";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { renderModelProvidersPageShell } from "../pages/model-providers/view.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { ShellLayoutOwner } from "./shell-layout-owner.ts";
import { createFooterControlRef, ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";

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

it("checks only visible footer surfaces inside the current shell content", () => {
  const content = document.createElement("main");
  const surface = document.createElement("div");
  document.body.append(content);
  content.append(surface);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  let visible = true;
  let rect = new DOMRect(60, 760, 600, 80);
  surface.checkVisibility = () => visible;
  surface.getBoundingClientRect = () => rect;
  const release = owner.registerFooterControlSurface(surface);
  const bounds = { left: 44, right: 284, top: 756, bottom: 800 };
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  visible = false;
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  visible = true;
  rect = new DOMRect(284, 760, 600, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  rect = new DOMRect(60, 760, 0, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  rect = new DOMRect(60, 760, 600, 80);
  document.body.append(surface);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  content.append(surface);
  content.remove();
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  document.body.append(content);
  release();
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  owner.registerFooterControlSurface(surface);
  owner.dispose();
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
});

it("releases replaced footer refs and the retained surface when their renderer retires", () => {
  const content = document.createElement("main");
  const host = document.createElement("div");
  const replacement = document.createElement("div");
  content.append(host, replacement);
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  let attach!: (element: HTMLElement) => void;
  function Surface() {
    attach = createFooterControlRef();
    return <div ref={attach}>Original footer</div>;
  }
  const view = render(
    () => (
      <ShellLayoutProvider value={{ owner, host }}>
        <Surface />
      </ShellLayoutProvider>
    ),
    { container: host },
  );
  const original = view.getByText("Original footer");
  original.checkVisibility = () => true;
  replacement.checkVisibility = () => true;
  original.getBoundingClientRect = () => new DOMRect(60, 760, 600, 80);
  replacement.getBoundingClientRect = () => new DOMRect(500, 760, 600, 80);
  const bounds = { left: 44, right: 284, top: 756, bottom: 800 };
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  attach(replacement);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  replacement.getBoundingClientRect = () => new DOMRect(60, 760, 600, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  view.unmount();
  expect(replacement.isConnected).toBe(true);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
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

it("publishes settings layout before mounted descendants measure updates", () => {
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
    onSettled(() => {
      observations.push(content.className);
    });
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

it("keeps layout traits through shell class updates and retires them with their reporter", () => {
  const owner = new ShellLayoutOwner();
  const [chat, setChat] = createSignal(false);
  const [shown, setShown] = createSignal(true);
  let content!: HTMLElement;
  const measurements: string[] = [];
  function Measure() {
    onSettled(() => {
      measurements.push(content.className);
    });
    createEffect(chat, () => {
      measurements.push(content.className);
    });
    return <span>Measured</span>;
  }
  render(() => (
    <main
      class={["content", { "content--chat": chat() }]}
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
        <Show when={shown()}>
          <SettingsPage wide>
            <SettingsPageHeader title="Settings" />
            <Measure />
          </SettingsPage>
        </Show>
      </ShellLayoutProvider>
    </main>
  ));
  expect(measurements[0]).toContain("content--settings-wide");
  setChat(true);
  flush();
  expect(content.classList.contains("content--chat")).toBe(true);
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(measurements.at(-1)).toContain("content--settings-wide");
  setShown(false);
  flush();
  expect(content.classList.contains("content--chat")).toBe(true);
  expect(content.classList.contains("content--settings-page")).toBe(false);
  expect(content.classList.contains("content--settings-wide")).toBe(false);
  expect(content.classList.contains("content--toolbar-header")).toBe(false);
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
  { bridged: false, detached: false, stacked: false },
  { bridged: false, detached: false, stacked: true },
  { bridged: true, detached: false, stacked: false },
  { bridged: true, detached: true, stacked: false },
])(
  "publishes initial page layout ($bridged bridge, $detached detached, $stacked stacked)",
  async ({ bridged, detached, stacked }) => {
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
                <SettingsPageHeader title="Native settings" stacked={stacked} />
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
    expect(content.classList.contains("content--toolbar-header")).toBe(!stacked);
  },
);
