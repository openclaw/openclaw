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

  it("keeps chat textareas at 16px without misplaced stylelint suppression", () => {
    const css = readLayoutCss();

    expect(css).toContain("font-size: 14px;");
    expect(css).toContain("font-size: 0.92rem;");
    expect(css).toMatch(
      /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*\.chat-compose \.chat-compose__field textarea,[\s\S]*\.agent-chat__input > textarea \{[\s\S]*font-size: 16px;/,
    );
    expect(css).not.toContain("stylelint-disable-next-line declaration-property-allowed-list");
  });
});
