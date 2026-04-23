import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("thread binding config keys", () => {
  it("rejects legacy session.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      session: {
        threadBindings: {
          ttlHours: 24,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "session.threadBindings",
        message: expect.stringContaining("ttlHours"),
      }),
    );
  });

  it("rejects legacy channels.<id>.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      channels: {
        demo: {
          threadBindings: {
            ttlHours: 24,
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "channels",
        message: expect.stringContaining("ttlHours"),
      }),
    );
  });

  it("rejects legacy channels.<id>.accounts.<id>.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      channels: {
        demo: {
          accounts: {
            alpha: {
              threadBindings: {
                ttlHours: 24,
              },
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "channels",
        message: expect.stringContaining("ttlHours"),
      }),
    );
  });
});
