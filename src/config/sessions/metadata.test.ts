import { describe, expect, test } from "vitest";
import { deriveSessionOrigin } from "./metadata.js";

describe("deriveSessionOrigin — system event providers (#54661)", () => {
  test.each([{ provider: "heartbeat" }, { provider: "cron-event" }, { provider: "exec-event" }])(
    "does not set origin.label for system provider $provider",
    ({ provider }) => {
      const origin = deriveSessionOrigin({
        Provider: provider,
        From: provider, // fallback sender value used by heartbeat-runner
        To: provider,
        Body: "heartbeat check",
      });

      expect(origin?.label).toBeUndefined();
    },
  );

  test("sets origin.label from From for a regular direct-chat provider", () => {
    const origin = deriveSessionOrigin({
      Provider: "telegram",
      From: "Alice",
      To: "bot",
      Body: "Hello",
      ChatType: "direct",
    });

    expect(origin?.label).toBe("Alice");
  });

  test("does not set label when From is empty", () => {
    const origin = deriveSessionOrigin({
      Provider: "telegram",
      From: "",
      To: "bot",
      Body: "Hello",
    });

    expect(origin?.label).toBeUndefined();
  });
});
