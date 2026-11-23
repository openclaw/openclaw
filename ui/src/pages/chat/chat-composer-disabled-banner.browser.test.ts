import { afterEach, expect, it } from "vitest";
import { renderComposerFixture, resetComposerFixture } from "./chat-composer.test-support.ts";
import "../../styles.css";
import "../../styles/chat/layout.css";

afterEach(() => resetComposerFixture());

it.each([
  ["eye", "14px"],
  ["archive", "18px"],
  ["warning", "18px"],
] as const)("preserves the %s disabled-banner icon treatment", (icon, size) => {
  const { container } = renderComposerFixture({
    canSend: false,
    disabledBanner: {
      kind: "composer-replacement",
      text: "This session is read-only.",
      tone: "neutral",
      icon,
    },
  });
  document.body.append(container);
  const symbol = container.querySelector(".agent-chat__disabled-banner-icon")!;
  const detail = container.querySelector(".agent-chat__disabled-banner-detail")!;
  expect(getComputedStyle(symbol).color === getComputedStyle(detail).color).toBe(
    icon !== "warning",
  );
  const svg = getComputedStyle(symbol.querySelector("svg")!);
  expect([svg.width, svg.height]).toEqual([size, size]);
});
