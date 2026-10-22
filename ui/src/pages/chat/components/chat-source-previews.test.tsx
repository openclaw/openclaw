/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatSourcePreviews } from "./chat-source-previews.tsx";

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
