import { createSignal, flush, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentIdentity } from "../../lib/identity-avatar-view.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { AgentIdentityAvatar as Avatar } from "./identity-avatar.tsx";

const observers: MutationObserver[] = [];
afterEach(() => observers.splice(0).forEach((observer) => observer.disconnect()));
function observe(target: Node, options: MutationObserverInit) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(target, options);
  observers.push(observer);
  return () => [...records, ...observer.takeRecords()];
}

function TestImage(props: { source: string | Promise<string | null> | null }) {
  const view = () => ({ imageUrl: props.source, pending: false });
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <span class={["test-avatar", presentation.classes()]} data-avatar-state={presentation.state()}>
      <Show when={Boolean(props.source)}>
        <IdentityAvatarImage view={view()} onStateChange={presentation.onStateChange} />
      </Show>
    </span>
  );
}

it("retains face nodes across same-ID publication", async () => {
  const [agent, publish] = createSignal<AgentIdentity>({ id: "forge", name: "Before" });
  const view = mountSolid(() => <Avatar agent={agent()} />);
  await vi.dynamicImportSettled();
  flush();
  const face = view.container.querySelector("svg.identity-avatar__agent-face")!;
  const features = face.querySelector("g")!;
  const nodes = [...features.querySelectorAll("*")];
  const mutations = observe(features, { childList: true, subtree: true });
  publish({ id: "forge", name: "After" });
  flush();
  expect(view.container.querySelector('[aria-label="After"]')).not.toBeNull();
  expect(view.container.querySelector("svg.identity-avatar__agent-face")).toBe(face);
  const retained = [...features.querySelectorAll("*")];
  expect(retained).toHaveLength(nodes.length);
  retained.forEach((node, index) => expect(node).toBe(nodes[index]));
  expect(mutations()).toHaveLength(0);
});

it.each(["load", "error"])("keeps settled %s state for the same URL", async (event) => {
  const pending = createDeferred<string>();
  const [source, publish] = createSignal<string | Promise<string>>(pending.promise);
  const view = mountSolid(() => <TestImage source={source()} />);
  pending.resolve("/avatar/settled");
  await pending.promise;
  const image = view.container.querySelector("img")!;
  image.dispatchEvent(new Event(event));
  flush();
  const mutations = observe(view.container, { subtree: true, attributes: true, childList: true });
  publish("/avatar/settled");
  flush();
  await Promise.resolve();
  expect(view.container.querySelector("img")).toBe(image);
  expect(mutations()).toHaveLength(0);
  expect(image.parentElement?.dataset.avatarState).toBe(event === "load" ? "loaded" : "failed");
});

it("ignores retired resource and image-node outcomes", async () => {
  const first = createDeferred<string>();
  const [source, setSource] = createSignal<string | Promise<string> | null>(first.promise);
  const view = mountSolid(() => <TestImage source={source()} />);
  const retiredImage = view.container.querySelector("img")!;
  setSource("/avatar/current");
  flush();
  retiredImage.dispatchEvent(new Event("load"));
  flush();
  first.resolve("/avatar/retired");
  await first.promise;
  flush();
  expect(view.container.querySelector("img")).toBe(retiredImage);
  expect(retiredImage.getAttribute("src")).toBe("/avatar/current");
  expect(retiredImage.parentElement?.dataset.avatarState).toBe("loaded");

  setSource(null);
  flush();
  setSource("/avatar/replacement");
  flush();
  const replacement = view.container.querySelector("img")!;
  expect(replacement).not.toBe(retiredImage);
  replacement.dispatchEvent(new Event("load"));
  flush();
  retiredImage.dispatchEvent(new Event("error"));
  flush();
  expect(replacement.getAttribute("src")).toBe("/avatar/replacement");
  expect(replacement.parentElement?.dataset.avatarState).toBe("loaded");
});

it("preserves prepared avatar state and image errors", () => {
  const failed = vi.fn();
  const [agent, setAgent] = createSignal<AgentIdentity>({
    id: "sidebar-person",
    name: "Synthetic assistant",
    textAvatar: "🦀",
    pending: true,
  });
  const view = mountSolid(() => <Avatar agent={agent()} class="avatar" onImageError={failed} />);
  const face = view.container.querySelector<HTMLElement>(".avatar");
  expect(face?.getAttribute("aria-label")).toBe("Synthetic assistant");
  expect(face?.dataset.avatarState).toBe("pending");
  expect(view.container.querySelector<HTMLElement>("[data-avatar]")?.dataset.avatar).toBe("🦀");

  const mutations = observe(face!, { attributes: true, attributeFilter: ["data-avatar-state"] });
  setAgent((current) => ({ ...current }));
  flush();
  expect(mutations()).toHaveLength(0);

  setAgent((current) => ({ ...current, avatar: "/avatar/sidebar-synthetic", pending: false }));
  flush();
  const image = view.container.querySelector("img")!;
  expect(image?.getAttribute("src")).toBe("/avatar/sidebar-synthetic");
  expect(view.container.querySelector(".avatar")).toBe(face);
  image.dispatchEvent(new Event("error"));
  flush();
  expect(failed).toHaveBeenCalledOnce();
  expect(face?.dataset.avatarState).toBe("failed");
  expect(face?.classList.contains("is-fallback")).toBe(true);
  setAgent((current) => ({ ...current, avatar: undefined }));
  flush();
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦀");
});

it.each(["emoji", "dispose"] as const)("retires pending face artwork on %s", async (mode) => {
  const [agent, setAgent] = createSignal<AgentIdentity>({ id: "retired-lazy-face" });
  const [visible, setVisible] = createSignal(true);
  const view = mountSolid(() => (
    <Show when={visible()}>
      <Avatar agent={agent()} />
    </Show>
  ));
  flush();
  if (mode === "emoji") {
    setAgent({ id: "retired-lazy-face", textAvatar: "🦀" });
  } else {
    setVisible(false);
  }
  flush();
  await vi.dynamicImportSettled();
  flush();
  expect(view.container.querySelector(".identity-avatar__agent-face")).toBeNull();
  if (mode === "emoji") {
    expect(
      view.container.querySelector<HTMLElement>(".identity-avatar__text")?.dataset.avatar,
    ).toBe("🦀");
  } else {
    expect(view.container.querySelector(".identity-avatar--agent")).toBeNull();
  }
});
