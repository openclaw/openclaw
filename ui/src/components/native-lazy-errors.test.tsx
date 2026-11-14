/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { ImageLightboxItemView } from "./image-lightbox-lazy.tsx";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { arrive, createPet } from "./lobster-pet.test-support.ts";
import "./solid/agent-avatar.tsx";
import "./image-lightbox.tsx";

// mock-isolation: Reject module evaluation to exercise the native lazy-face error boundary.
vi.mock("./agent-avatar-face.tsx", () => {
  throw new Error("Synthetic face import failure");
});
// mock-isolation: Reject module evaluation to exercise the native lazy-menu error boundary.
vi.mock("./lobster-pet-dismiss-menu.tsx", () => {
  throw new Error("Synthetic dismiss menu import failure");
});
// mock-isolation: Reject module evaluation to exercise the native lazy-lightbox error boundary.
vi.mock("./image-lightbox-content.tsx", () => {
  throw new Error("Synthetic lightbox import failure");
});

afterEach(async () => {
  for (const host of document.querySelectorAll(
    "openclaw-agent-avatar, openclaw-lobster-pet, openclaw-image-lightbox",
  )) {
    host.remove();
  }
  await waitForSolid(() => expect(document.querySelector('[role="alert"]')).toBeNull());
  document.body.replaceChildren();
  vi.useRealTimers();
  localStorage.clear();
});

describe("native lazy renderer failures", () => {
  it("keeps a cold Solid lightbox failure retryable and dismissible without a phantom native host", async () => {
    const close = vi.fn();
    const view = mountSolid(() => {
      const [item, setItem] = createSignal<ImageLightboxItem | null>({
        src: "synthetic.png",
        title: "Cold synthetic image",
      });
      return (
        <ImageLightboxItemView
          item={item()}
          onClose={() => {
            close();
            setItem(null);
          }}
        />
      );
    });
    await waitForSolid(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Cold synthetic image",
      ),
    );
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.querySelector(".lazy-view-error__action")).not.toBeNull();
    expect(view.container.querySelector("openclaw-image-lightbox")).toBeNull();
    const dismiss = [...alert.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Close",
    )!;
    dismiss.click();
    await waitForSolid(() => expect(document.querySelector('[role="alert"]')).toBeNull());
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps the native avatar host and renders a decorative fallback", async () => {
    const avatar = document.createElement("openclaw-agent-avatar");
    avatar.option = { value: "synthetic-agent", label: "Synthetic agent" };
    document.body.append(avatar);
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(avatar.querySelector(".identity-avatar__text")?.getAttribute("data-avatar")).toBe("?"),
    );
    const fallback = avatar.querySelector(".identity-avatar__fallback");
    avatar.option = { value: "synthetic-agent", label: "Updated synthetic agent" };
    await waitForSolid(() =>
      expect(avatar.querySelector(".identity-avatar__fallback")).toBe(fallback),
    );
    expect(document.querySelector("openclaw-agent-avatar")).toBe(avatar);
  });

  it("keeps the pet and lets its owner close a failed dismiss menu", async () => {
    vi.useFakeTimers();
    const pet = createPet(42);
    await arrive(pet);
    const sprite = pet.querySelector(".lobster-pet");
    expect(sprite).not.toBeNull();
    sprite!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 120 }),
    );
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(pet.querySelector(".lobster-pet")).toBe(sprite);
    const close = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
    ).find((button) => button.textContent === "Close");
    expect(close).toBeDefined();
    close!.click();
    await waitForSolid(() => expect(document.querySelector('[role="alert"]')).toBeNull());
    expect(pet.querySelector(".lobster-pet")).toBe(sprite);
  });

  it("keeps a failed native lightbox closable through its existing event", async () => {
    const lightbox = document.createElement("openclaw-image-lightbox");
    lightbox.imageTitle = "Synthetic image";
    const close = vi.fn();
    document.body.addEventListener("image-lightbox-close", close, { once: true });
    const preview = document.createElement("div");
    preview.style.cssText = "height:0;overflow:hidden";
    preview.append(lightbox);
    document.body.append(preview);
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(preview.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Synthetic image");
    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="alert"] button'),
    ).find((item) => item.textContent === "Close");
    expect(button).toBeDefined();
    button!.click();
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ bubbles: true, composed: true }));
    expect(document.querySelector("openclaw-image-lightbox")).toBe(lightbox);
  });
});
