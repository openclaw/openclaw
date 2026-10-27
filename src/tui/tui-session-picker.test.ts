import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionChoices } from "./tui-session-picker.js";

describe("buildSessionChoices", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { preview: undefined, description: "5m ago" },
    { preview: "", description: "5m ago" },
    { preview: " \t\n ", description: "5m ago" },
    { preview: " Hello\nworld ", description: "5m ago · Hello world" },
  ])("keeps the update time with preview $preview", ({ preview, description }) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const [choice] = buildSessionChoices([
      {
        key: "agent:main:recent",
        updatedAt: 1_799_999_700_000,
        lastMessagePreview: preview,
      },
    ]);

    expect(choice?.description).toBe(description);
  });

  it("renders the Gateway display projection without reinterpreting quoted directives", () => {
    const [choice] = buildSessionChoices([
      {
        key: "agent:main:quoted-directive",
        lastMessagePreview: "Use `[[reply_to_current]]` literally.",
      },
    ]);

    expect(choice?.description).toBe("Use `[[reply_to_current]]` literally.");
  });
});
