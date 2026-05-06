import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readLayoutCss(): string {
  const cssPath = [
    resolve(process.cwd(), "src/styles/chat/layout.css"),
    resolve(process.cwd(), "ui/src/styles/chat/layout.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

describe("chat layout styles", () => {
  it("styles queued-message steering controls and pending indicators", () => {
    const css = readLayoutCss();

    expect(css).toContain(".chat-queue__steer");
    expect(css).toContain(".chat-queue__actions");
    expect(css).toContain(".chat-queue__item--steered");
    expect(css).toContain(".chat-queue__badge");
  });

  it("includes assistant text avatar styles for configured IDENTITY avatars", () => {
    const css = readLayoutCss();

    expect(css).toContain(".agent-chat__avatar--text");
    expect(css).toContain("font-size: 20px;");
    expect(css).toContain("place-items: center;");
  });

  it("keeps mobile composer icon controls at touch-friendly sizes", () => {
    const css = readLayoutCss();

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(
      "(max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
    expect(css).toContain(".agent-chat__input-btn,");
    expect(css).toContain(".agent-chat__toolbar .btn--ghost,");
    expect(css).toContain(".chat-send-btn");
    expect(css).toContain("width: 44px;");
    expect(css).toContain("height: 44px;");
  });
});
