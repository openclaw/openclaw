import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
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

function createShell(nested = false) {
  const content = document.createElement("main");
  content.className = "content";
  const host = nested ? document.createElement("div") : content;
  if (nested) {
    content.append(host);
  }
  document.body.append(content);
  const owner = new ShellLayoutOwner();
  owner.contentRef(content);
  const mount = (view: () => JSX.Element) =>
    render(() => <ShellLayoutProvider value={{ owner, host }}>{view()}</ShellLayoutProvider>, {
      container: host,
    });
  return { content, host, owner, mount };
}

const bounds = { left: 44, right: 284, top: 756, bottom: 800 };
const footerRect = () => new DOMRect(60, 760, 600, 80);

function Measure(props: {
  source: () => boolean;
  content: () => HTMLElement;
  observations: string[];
}) {
  const record = () => {
    props.observations.push(props.content().className);
  };
  onSettled(record);
  createEffect(
    () => props.source(),
    () => record(),
  );
  return <span>Measured</span>;
}

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
  const { content, owner } = createShell();
  const surface = document.createElement("div");
  content.append(surface);
  let visible = true;
  let rect = footerRect();
  surface.checkVisibility = () => visible;
  surface.getBoundingClientRect = () => rect;
  const release = owner.registerFooterControlSurface(surface);
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  visible = false;
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  visible = true;
  rect = new DOMRect(284, 760, 600, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  rect = new DOMRect(60, 760, 0, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  rect = footerRect();
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
  const { content, owner, mount } = createShell(true);
  const replacement = document.createElement("div");
  content.append(replacement);
  let attach!: (element: HTMLElement) => void;
  function Surface() {
    attach = createFooterControlRef();
    return <div ref={attach}>Original footer</div>;
  }
  const view = mount(() => <Surface />);
  const original = view.getByText("Original footer");
  original.checkVisibility = () => true;
  replacement.checkVisibility = () => true;
  original.getBoundingClientRect = footerRect;
  replacement.getBoundingClientRect = () => new DOMRect(500, 760, 600, 80);
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  attach(replacement);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
  replacement.getBoundingClientRect = footerRect;
  expect(owner.footerControlsOverlap(bounds)).toBe(true);
  view.unmount();
  expect(replacement.isConnected).toBe(true);
  expect(owner.footerControlsOverlap(bounds)).toBe(false);
});

it("reserves the Models page column before its body finishes loading", () => {
  const { content, mount } = createShell();
  const [loaded, setLoaded] = createSignal(false);
  mount(() =>
    renderModelProvidersPageShell({
      get body() {
        return (
          <Show when={loaded()} fallback={<span>Loading models</span>}>
            <SettingsPage>Models ready</SettingsPage>
          </Show>
        );
      },
      login: undefined,
    }),
  );
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(content.textContent).toContain("Loading models");
  setLoaded(true);
  flush();
  expect(content.classList.contains("content--settings-page")).toBe(true);
  expect(content.textContent).toContain("Models ready");
});

it("publishes settings layout before mounted descendants measure updates", () => {
  const { content, mount } = createShell(true);
  const [wide, setWide] = createSignal(true);
  const observations: string[] = [];
  mount(() => (
    <SettingsWorkspace>
      <SettingsPage wide={wide()}>
        <SettingsPageHeader title="Settings" />
        <Measure source={wide} content={() => content} observations={observations} />
      </SettingsPage>
    </SettingsWorkspace>
  ));
  for (const trait of ["settings-workspace", "settings-page", "settings-wide", "toolbar-header"]) {
    expect(observations[0]).toContain(`content--${trait}`);
  }
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
            <Measure source={chat} content={() => content} observations={measurements} />
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
  const { content, mount } = createShell();
  const [shown, setShown] = createSignal(true);
  mount(() => (
    <>
      <Show when={shown()}>
        <SettingsPage wide>First</SettingsPage>
      </Show>
      <div hidden>
        <SettingsPage>Retained</SettingsPage>
      </div>
    </>
  ));
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
