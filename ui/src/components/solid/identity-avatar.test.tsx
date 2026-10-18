import { render as mountSolid } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
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
