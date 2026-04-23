import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("root BlueBubbles webhook secret validation", () => {
  it("rejects missing webhookSecret when serverUrl is configured", () => {
    const result = validateConfigObjectRaw({
      channels: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "channels.bluebubbles.webhookSecret",
      );
      expect(issue?.message).toBe("webhookSecret is required when serverUrl is configured");
    }
  });

  it("rejects webhookSecret when it matches password", () => {
    const result = validateConfigObjectRaw({
      channels: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: "test-password",
          webhookSecret: "test-password",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "channels.bluebubbles.webhookSecret",
      );
      expect(issue?.message).toBe("webhookSecret must differ from password");
    }
  });

  it("rejects webhookSecret when it reuses the same SecretRef as password", () => {
    const result = validateConfigObjectRaw({
      channels: {
        bluebubbles: {
          serverUrl: "http://localhost:1234",
          password: {
            source: "env",
            provider: "default",
            id: "BLUEBUBBLES_PASSWORD",
          },
          webhookSecret: {
            source: "env",
            provider: "default",
            id: "BLUEBUBBLES_PASSWORD",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "channels.bluebubbles.webhookSecret",
      );
      expect(issue?.message).toBe("webhookSecret must differ from password");
    }
  });

  it("accepts inherited top-level webhook credentials for account-scoped serverUrl", () => {
    const result = validateConfigObjectRaw({
      channels: {
        bluebubbles: {
          password: "base-password",
          webhookSecret: "base-webhook-secret",
          accounts: {
            work: {
              serverUrl: "http://localhost:1234",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects inherited webhook credentials when the effective secrets match", () => {
    const result = validateConfigObjectRaw({
      channels: {
        bluebubbles: {
          password: "shared-secret",
          webhookSecret: "shared-secret",
          accounts: {
            work: {
              serverUrl: "http://localhost:1234",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "channels.bluebubbles.accounts.work.webhookSecret",
      );
      expect(issue?.message).toBe(
        "webhookSecret must differ from the effective BlueBubbles password",
      );
    }
  });
});
