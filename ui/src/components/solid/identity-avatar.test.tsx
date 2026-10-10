import { render as mountSolid } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { AgentAvatar } from "../agent-avatar.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar.tsx";

it("carries prepared avatar state and image errors across the Solid custom-element boundary", async () => {
  const onImageError = vi.fn();
  const view = mountSolid(() =>
    renderAgentIdentityAvatar(
      { id: "sidebar-person", name: "Synthetic assistant", textAvatar: "🦀", pending: true },
      "sidebar-synthetic-avatar",
      onImageError,
    ),
  );
  try {
    const avatar = view.container.querySelector<AgentAvatar>("openclaw-agent-avatar");
    if (!avatar) {
      throw new Error("Solid did not mount the agent avatar");
    }
    await avatar.updateComplete;
    const face = avatar.querySelector(".sidebar-synthetic-avatar");
    expect(face?.getAttribute("aria-label")).toBe("Synthetic assistant");
    expect(face?.getAttribute("data-avatar-state")).toBe("pending");
    expect(avatar.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe("🦀");
    expect(avatar.hasAttribute("presentation")).toBe(false);

    avatar.presentation = {
      agent: {
        id: "sidebar-person",
        name: "Synthetic assistant",
        textAvatar: "🦀",
        avatar: "/avatar/sidebar-synthetic",
        pending: false,
      },
      className: "sidebar-synthetic-avatar",
      onImageError,
    };
    await avatar.updateComplete;
    const image = avatar.querySelector("img");
    expect(image?.getAttribute("src")).toBe("/avatar/sidebar-synthetic");
    expect(avatar.querySelector(".sidebar-synthetic-avatar")).toBe(face);
    if (!image) {
      throw new Error("Prepared avatar did not render its image");
    }
    image.dispatchEvent(new Event("error"));
    expect(onImageError).toHaveBeenCalledOnce();
    expect(face?.getAttribute("data-avatar-state")).toBe("failed");
  } finally {
    view.unmount();
  }
});
