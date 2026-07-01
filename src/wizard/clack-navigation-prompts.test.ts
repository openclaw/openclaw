// Navigation prompt tests cover shared onboarding footer copy.
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { formatNavigationFooter } from "./clack-navigation-prompts.js";

describe("formatNavigationFooter", () => {
  it("omits the footer when no navigation is possible", () => {
    expect(formatNavigationFooter({ canGoBack: false, canGoForward: false })).toBe("");
  });

  it("renders compact back and forward guidance for navigable onboarding prompts", () => {
    expect(stripAnsi(formatNavigationFooter({ canGoBack: true, canGoForward: true }))).toBe(
      "← back  → next",
    );
  });

  it("renders only the available navigation action", () => {
    expect(stripAnsi(formatNavigationFooter({ canGoBack: true, canGoForward: false }))).toBe(
      "← back",
    );
    expect(stripAnsi(formatNavigationFooter({ canGoBack: false, canGoForward: true }))).toBe(
      "→ next",
    );
  });

  it("omits the footer outside prompt navigation", () => {
    expect(formatNavigationFooter(undefined)).toBe("");
  });
});
