import { expect, it } from "vitest";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";

it.each([
  {
    to: "https://example.invalid/job",
    expected: { mode: "webhook", to: "https://example.invalid/job" },
  },
  {
    to: "telegram:123",
    expected: {
      mode: "announce",
      to: "telegram:123",
      completionDestination: { mode: "webhook", to: "https://example.invalid/fallback" },
    },
  },
])("preserves the mode-less notify destination $to", ({ to, expected }) => {
  const raw: Record<string, unknown> = { id: "legacy", notify: true, delivery: { to } };
  expect(
    migrateLegacyNotifyFallback({
      jobs: [raw],
      legacyWebhook: "https://example.invalid/fallback",
    }),
  ).toEqual({ changed: true, warnings: [] });
  expect(raw.delivery).toEqual(expected);
  expect(raw).not.toHaveProperty("notify");
});
