/* @vitest-environment jsdom */

import { setWriteHook } from "@solidjs/signals";
import { createRoot, createSignal, onSettled } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSourcePreviews } from "./chat-source-previews.tsx";

it("does not request favicons after disposal before the first settlement", () => {
  const fetchFavicon = vi.fn(async () => null);
  let settled = false;
  const view = mountSolid(() => {
    createRoot((dispose) => {
      onSettled(() => {
        settled = true;
      });
      const content = (
        <ChatSourcePreviews
          fetchFavicon={fetchFavicon}
          sources={[{ url: "https://retired.test/page", title: "Retired", domain: "retired.test" }]}
        />
      );
      dispose();
      return content;
    });
    return null;
  });
  flush();
  expect(fetchFavicon).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  view.unmount();
});

it("requests a favicon once after settlement and ignores its result after disposal", async () => {
  const pending = Promise.withResolvers<string | null>();
  const fetchFavicon = vi.fn(() => pending.promise);
  const view = mountSolid(() => (
    <ChatSourcePreviews
      fetchFavicon={fetchFavicon}
      sources={[{ url: "https://held.test/page", title: "Held", domain: "held.test" }]}
    />
  ));
  await waitForSolid(() => expect(fetchFavicon).toHaveBeenCalledOnce());
  expect(view.container.querySelector("img")).toBeNull();
  view.unmount();
  const writes = vi.fn();
  try {
    setWriteHook(writes);
    pending.resolve("https://held.test/favicon.png");
    await pending.promise;
    await Promise.resolve();
    expect(writes).not.toHaveBeenCalled();
  } finally {
    setWriteHook(null);
    pending.resolve(null);
    view.unmount();
  }
});

it("opens the matching source dialog and retires it when that source leaves", () => {
  const [sources, setSources] = createSignal<readonly ChatSourcePreview[]>([
    {
      url: "https://example.test/checklist",
      title: "Trip checklist",
      domain: "example.test",
      excerpt: "Bring a spare tube.",
      excerptKind: "page",
    },
  ]);
  const view = mountSolid(() => <ChatSourcePreviews sources={sources()} />);
  const { container } = view;
  flush();
  const trigger = container.querySelector<HTMLButtonElement>(".chat-source-card")!;
  expect(view.getByRole("button", { name: "Trip checklistexample.test" })).toBe(trigger);
  trigger.click();
  const surface = container.querySelector<HTMLElement>(".chat-source-popover")!;
  expect(surface.matches(":popover-open")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(surface.querySelector(".chat-source-popover__excerpt")?.textContent).toBe(
    "Bring a spare tube.",
  );
  expect(surface.querySelector("a")?.getAttribute("href")).toBe("https://example.test/checklist");
  setSources([]);
  flush();
  expect(container.querySelector(".chat-source-card")).toBeNull();
  expect(surface.matches(":popover-open")).toBe(false);
});

it("retires only a failed favicon and retains the other source card", async () => {
  const fetchFavicon = vi.fn(async (hostname: string) => `https://${hostname}/favicon.png`);
  const { container } = mountSolid(() => (
    <ChatSourcePreviews
      fetchFavicon={fetchFavicon}
      sources={[
        { url: "https://first.test/page", title: "First", domain: "first.test" },
        { url: "https://second.test/page", title: "Second", domain: "second.test" },
      ]}
    />
  ));
  await waitForSolid(() => expect(container.querySelectorAll("img")).toHaveLength(2));
  const [failedImage, retainedImage] = container.querySelectorAll("img");
  const retainedCard = retainedImage!.closest(".chat-source-card");

  failedImage!.dispatchEvent(new Event("error"));
  flush();

  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")).toBe(retainedImage);
  expect(retainedImage!.closest(".chat-source-card")).toBe(retainedCard);
  expect(fetchFavicon).toHaveBeenCalledTimes(2);
});
