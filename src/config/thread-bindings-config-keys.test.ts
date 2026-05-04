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

  it("accepts channel-level thread binding ttlHours compatibility", () => {
    const result = validateConfigObjectRaw({
      channels: {
        demo: {
          threadBindings: {
            ttlHours: 24,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects touched channel-level thread binding ttlHours during raw write validation", () => {
    const result = validateConfigObjectRaw(
      {
        channels: {
          demo: {
            threadBindings: {
              ttlHours: 24,
            },
          },
        },
      },
      {
        touchedPaths: [["channels", "demo", "threadBindings", "ttlHours"]],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "channels",
        message: expect.stringContaining("threadBindings.ttlHours"),
      }),
    );
  });

  it("accepts account-level thread binding ttlHours compatibility", () => {
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

    expect(result.ok).toBe(true);
  });
});
