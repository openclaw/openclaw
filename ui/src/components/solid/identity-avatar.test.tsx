import { createSignal, flush, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { AgentIdentity } from "../identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

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
