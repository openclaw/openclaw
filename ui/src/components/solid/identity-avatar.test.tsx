import { createSignal, flush, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import type { AgentIdentity } from "../../lib/identity-avatar-view.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

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

it("retains the face subtree when a publication replaces the agent with the same ID", async () => {
  const [agent, publish] = createSignal<AgentIdentity>({ id: "forge", name: "Before" });
  const view = mountSolid(() => <AgentIdentityAvatar agent={agent()} />);
  try {
    await vi.dynamicImportSettled();
    flush();
    const face = view.container.querySelector("svg.identity-avatar__agent-face")!;
    const features = face.querySelector("g")!;
    const nodes = [...features.querySelectorAll("*")];
    const mutations = new MutationObserver(() => undefined);
    mutations.observe(features, { childList: true, subtree: true });
    try {
      publish({ id: "forge", name: "After" });
      flush();
      expect(view.container.querySelector('[aria-label="After"]')).not.toBeNull();
      expect(view.container.querySelector("svg.identity-avatar__agent-face")).toBe(face);
      const retained = [...features.querySelectorAll("*")];
      expect(retained).toHaveLength(nodes.length);
      retained.forEach((node, index) => expect(node).toBe(nodes[index]));
      expect(mutations.takeRecords()).toHaveLength(0);
    } finally {
      mutations.disconnect();
    }
  } finally {
    view.unmount();
  }
});

it.each(["load", "error"])(
  "keeps a settled %s image when its pending resource becomes the same URL",
  async (event) => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const [source, publish] = createSignal<{ imageUrl: string | Promise<string> }>({
      imageUrl: pending,
    });
    const view = mountSolid(() => <TestImage source={source().imageUrl} />);
    try {
      resolve("/avatar/settled");
      await pending;
      const image = view.container.querySelector("img")!;
      image.dispatchEvent(new Event(event));
      flush();
      const records: MutationRecord[] = [];
      const mutations = new MutationObserver((batch) => records.push(...batch));
      mutations.observe(view.container, { subtree: true, attributes: true, childList: true });
      try {
        publish({ imageUrl: "/avatar/settled" });
        flush();
        await Promise.resolve();
        expect(view.container.querySelector("img")).toBe(image);
        expect([...records, ...mutations.takeRecords()]).toHaveLength(0);
        expect(image.parentElement?.getAttribute("data-avatar-state")).toBe(
          event === "load" ? "loaded" : "failed",
        );
      } finally {
        mutations.disconnect();
      }
    } finally {
      view.unmount();
    }
  },
);

it("ignores retired image outcomes after a source or image-node replacement", async () => {
  let resolveFirst!: (value: string) => void;
  const first = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  const [source, setSource] = createSignal<string | Promise<string> | null>(first);
  const view = mountSolid(() => <TestImage source={source()} />);
  try {
    const retiredImage = view.container.querySelector("img")!;
    setSource("/avatar/current");
    flush();
    retiredImage.dispatchEvent(new Event("load"));
    flush();
    resolveFirst("/avatar/retired");
    await first;
    flush();
    expect(view.container.querySelector("img")).toBe(retiredImage);
    expect(retiredImage.getAttribute("src")).toBe("/avatar/current");
    expect(retiredImage.parentElement?.getAttribute("data-avatar-state")).toBe("loaded");

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
    expect(replacement.parentElement?.getAttribute("data-avatar-state")).toBe("loaded");
  } finally {
    view.unmount();
  }
});

it("carries prepared avatar state and image errors across Solid updates", () => {
  const onImageError = vi.fn();
  const [agent, setAgent] = createSignal<AgentIdentity>({
    id: "sidebar-person",
    name: "Synthetic assistant",
    textAvatar: "🦀",
    pending: true,
  });
  const view = mountSolid(() => (
    <AgentIdentityAvatar
      agent={agent()}
      class="sidebar-synthetic-avatar"
      onImageError={onImageError}
    />
  ));
  try {
    const face = view.container.querySelector(".sidebar-synthetic-avatar");
    expect(face?.getAttribute("aria-label")).toBe("Synthetic assistant");
    expect(face?.getAttribute("data-avatar-state")).toBe("pending");
    expect(view.container.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦀");

    const mutations = new MutationObserver(() => undefined);
    mutations.observe(face!, { attributes: true, attributeFilter: ["data-avatar-state"] });
    try {
      setAgent({ ...agent() });
      flush();
      expect(mutations.takeRecords()).toHaveLength(0);
    } finally {
      mutations.disconnect();
    }

    setAgent({ ...agent(), avatar: "/avatar/sidebar-synthetic", pending: false });
    flush();
    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/avatar/sidebar-synthetic");
    expect(view.container.querySelector(".sidebar-synthetic-avatar")).toBe(face);
    if (!image) {
      throw new Error("Prepared avatar did not render its image");
    }
    image.dispatchEvent(new Event("error"));
    flush();
    expect(onImageError).toHaveBeenCalledOnce();
    expect(face?.getAttribute("data-avatar-state")).toBe("failed");
  } finally {
    view.unmount();
  }
});

it.each(["emoji", "dispose"] as const)(
  "retires pending face artwork when the native avatar changes to %s",
  async (mode) => {
    const [agent, setAgent] = createSignal<AgentIdentity>({ id: "retired-lazy-face" });
    const [visible, setVisible] = createSignal(true);
    const view = mountSolid(() => (
      <Show when={visible()}>
        <AgentIdentityAvatar agent={agent()} />
      </Show>
    ));
    try {
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
          view.container.querySelector(".identity-avatar__text")?.getAttribute("data-avatar"),
        ).toBe("🦀");
      } else {
        expect(view.container.querySelector(".identity-avatar--agent")).toBeNull();
      }
    } finally {
      view.unmount();
    }
  },
);
