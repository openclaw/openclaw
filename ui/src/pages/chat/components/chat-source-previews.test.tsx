/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
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
  const { container } = mountSolid(() => <ChatSourcePreviews sources={sources()} />);
  flush();
  const trigger = container.querySelector<HTMLButtonElement>(".chat-source-card")!;
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
