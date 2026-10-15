/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import "./chat-source-previews.tsx";

afterEach(() => document.body.replaceChildren());

it("opens the matching source dialog and retires it when that source leaves", async () => {
  const host = document.createElement("openclaw-chat-sources");
  host.sources = [
    {
      url: "https://example.test/checklist",
      title: "Trip checklist",
      domain: "example.test",
      excerpt: "Bring a spare tube.",
      excerptKind: "page",
    },
  ];
  document.body.append(host);
  await host.updateComplete;
  const trigger = host.querySelector<HTMLButtonElement>(".chat-source-card")!;
  trigger.click();
  const surface = host.querySelector<HTMLElement>(".chat-source-popover")!;
  expect(surface.matches(":popover-open")).toBe(true);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(surface.querySelector(".chat-source-popover__excerpt")?.textContent).toBe(
    "Bring a spare tube.",
  );
  expect(surface.querySelector("a")?.getAttribute("href")).toBe("https://example.test/checklist");
  host.sources = [];
  await host.updateComplete;
  expect(host.querySelector(".chat-source-card")).toBeNull();
  expect(surface.matches(":popover-open")).toBe(false);
});
