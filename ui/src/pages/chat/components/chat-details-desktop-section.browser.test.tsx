import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { ControlUiSessionAccessory } from "../../../../../src/plugin-sdk/control-ui.ts";
import { createTestControlUiPluginHost } from "../../../test-helpers/control-ui-plugin-host.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { mountSolid as mountNativeSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";
import { ChatDetailsEnvironment } from "./chat-details-environment.tsx";
import baseStyles from "../../../styles/base.css?inline";

let container: HTMLDivElement;
afterEach(() => container?.remove());

function mount(initiallyExpanded: boolean, height = 80) {
  container = document.body.appendChild(document.createElement("div"));
  function Section(props: { height: number; presented: boolean }) {
    const [expanded, setExpanded] = createSignal(initiallyExpanded);
    return (
      <ChatDetailsDesktopSection
        section="outputs"
        title="Outputs"
        expanded={expanded()}
        presented={props.presented}
        onExpandedChange={setExpanded}
      >
        <div style={{ height: `${props.height}px` }}>
          <button type="button">Open artifact</button>
        </div>
      </ChatDetailsDesktopSection>
    );
  }
  const view = mountSolid(Section, { height, presented: true }, container);
  const disclosure = container.querySelector("details")!;
  const summary = container.querySelector("summary")!;
  return {
    view,
    disclosure,
    summary,
    get artifact() {
      return container.querySelector("button")!;
    },
  };
}

async function settleAnimations(element: HTMLElement) {
  flush();
  // Deliver the resize, then observe replacements instead of tracking cancelled promises.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  await expect
    .poll(() =>
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) => animation.playState !== "finished" && animation.playState !== "idle",
        ),
    )
    .toHaveLength(0);
}

async function toggle(summary: HTMLElement, keyboard = false) {
  await (keyboard ? userEvent.keyboard("{Enter}") : userEvent.click(summary));
  flush();
}

it("constructs closed content on first keyboard reveal and retains it across later reveals", async () => {
  const fixture = mount(false);
  const { disclosure, summary } = fixture;
  expect(disclosure.open).toBe(false);
  expect(fixture.artifact).toBeNull();
  summary.focus();
  await toggle(summary, true);
  const artifact = fixture.artifact;
  expect(disclosure.open).toBe(true);
  expect(artifact.checkVisibility()).toBe(true);
  expect(disclosure.getAnimations({ subtree: true })).toHaveLength(0);
  await userEvent.tab();
  expect(document.activeElement).toBe(artifact);
  summary.focus();
  await toggle(summary, true);
  expect(disclosure.open).toBe(false);
  expect(document.activeElement).toBe(summary);
  expect(fixture.artifact).toBe(artifact);
  await toggle(summary, true);
  expect(fixture.artifact).toBe(artifact);
  expect(artifact.checkVisibility()).toBe(true);
});

it("reverses a pointer collapse, accommodates new content, and settles when parked", async () => {
  const { view, disclosure, summary, artifact } = mount(true);
  expect(disclosure.open).toBe(true);
  expect(artifact.checkVisibility()).toBe(true);
  await toggle(summary);
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(artifact.closest("[inert]")).not.toBeNull();
  await toggle(summary);
  view.update({ height: 160, presented: true });
  await settleAnimations(disclosure);
  expect(disclosure.open).toBe(true);
  expect(artifact.closest("[inert]")).toBeNull();
  // The body is not stuck at the old height when its real content grows.
  expect(disclosure.getBoundingClientRect().height).toBeGreaterThan(160);
  await toggle(summary);
  view.update({ height: 160, presented: false });
  expect(disclosure.open).toBe(false);
  expect(disclosure.getAnimations({ subtree: true })).toHaveLength(0);
});

it("opens from the collapsed height and reverses from the visible height", async () => {
  const { disclosure, summary } = mount(false);
  const body = disclosure.querySelector<HTMLElement>(".chat-details-desktop-section__body")!;
  const animate = body.animate.bind(body);
  // Pause at creation before a resize callback can retarget advancing geometry.
  const animationSpy = vi.spyOn(body, "animate").mockImplementation((frames, options) => {
    const animation = animate(frames, options);
    animation.pause();
    return animation;
  });
  onTestFinished(() => animationSpy.mockRestore());
  await toggle(summary);
  const opening = body.getAnimations()[0]!;
  opening.currentTime = 0;
  expect(body.getBoundingClientRect().height).toBe(0);
  opening.currentTime = Number(opening.effect!.getTiming().duration) / 2;
  const visibleHeight = body.getBoundingClientRect().height;
  expect(visibleHeight).toBeGreaterThan(0);
  expect(visibleHeight).toBeLessThan(80);

  await toggle(summary);
  const closing = body.getAnimations()[0]!;
  closing.currentTime = 0;
  expect(body.getBoundingClientRect().height).toBeCloseTo(visibleHeight, 0);
  const finished = new Promise<void>((resolve) => {
    closing.addEventListener("finish", () => resolve(), { once: true });
  });
  closing.finish();
  await finished;
  expect(disclosure.open).toBe(false);
  expect(body.style.height).toBe("");
});

it("reveals content that arrives after an initially empty opening", async () => {
  const { view, disclosure, summary } = mount(false, 0);
  await userEvent.click(summary);
  await settleAnimations(disclosure);
  const body = disclosure.querySelector<HTMLElement>(".chat-details-desktop-section__body")!;
  const animate = body.animate.bind(body);
  const animationSpy = vi.spyOn(body, "animate").mockImplementation((frames, options) => {
    const animation = animate(frames, options);
    animation.pause();
    return animation;
  });
  onTestFinished(() => animationSpy.mockRestore());
  view.update({ height: 80, presented: true });
  flush();
  // Keep async content clipped before its resize observer can start the reveal.
  expect(body.getBoundingClientRect().height).toBe(0);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  // Async section content starts at the retained empty geometry instead of flashing full size.
  expect(body.getBoundingClientRect().height).toBe(0);
  const reveal = body.getAnimations()[0]!;
  reveal.finish();
  await settleAnimations(disclosure);
  expect(body.getBoundingClientRect().height).toBe(80);
});

it("discovers a contributed Environment from a cold collapsed empty section", async () => {
  const context = createInitializationContext(createTestGatewayClient(async () => ({})));
  const host = createTestControlUiPluginHost(context, "fixture-environment");
  let show: (() => void) | undefined;
  const accessory: ControlUiSessionAccessory = {
    id: "environment",
    placement: "session-environment",
    mount(target, current) {
      current.props.onPresenceChange?.(false);
      show = () => {
        const button = document.createElement("button");
        button.textContent = "Open fixture workspace";
        target.append(button);
        current.props.onPresenceChange?.(true);
      };
      return { dispose: () => target.replaceChildren() };
    },
  };
  const registrations = [
    {
      key: "fixture-environment/environment",
      pluginId: "fixture-environment",
      host,
      signal: host.signal,
      value: accessory,
    },
  ];
  Object.defineProperty(context, "plugins", {
    value: new Proxy(context.plugins, {
      get(target, key, receiver) {
        if (key === "registrations") {
          return (kind: string) => (kind === "accessories" ? registrations : []);
        }
        return Reflect.get(target, key, receiver);
      },
    }),
  });
  container = document.body.appendChild(document.createElement("div"));
  const view = mountNativeSolid(
    () => (
      <>
        <style>{baseStyles}</style>
        <ChatDetailsEnvironment
          details={{
            sessionKey: "agent:main:fixture",
            currentAgentId: "main",
            selectedSession: undefined,
            messages: [],
          }}
          expanded={false}
          presented
        />
      </>
    ),
    {
      container,
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  await expect.poll(() => typeof show).toBe("function");
  const shell = container.querySelector<HTMLElement>(".chat-details-desktop-environment")!;
  const disclosure = shell.querySelector("details")!;
  expect(shell.hidden).toBe(true);
  show!();
  await expect.poll(() => shell.hidden).toBe(false);
  expect(disclosure.open).toBe(false);
  const button = shell.querySelector<HTMLButtonElement>("button")!;
  expect(button.closest("[inert]")).not.toBeNull();
  view.unmount();
});
