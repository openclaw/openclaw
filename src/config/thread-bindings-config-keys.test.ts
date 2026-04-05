import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "../commands/doctor/shared/legacy-config-migrate.js";
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

  it("migrates session.threadBindings.ttlHours to idleHours", () => {
    const result = migrateLegacyConfig({
      session: {
        threadBindings: {
          ttlHours: 24,
        },
      },
    });

    expect(result.config?.session?.threadBindings?.idleHours).toBe(24);
    const normalized = result.config?.session?.threadBindings as
      | Record<string, unknown>
      | undefined;
    expect(normalized?.ttlHours).toBeUndefined();
    expect(result.changes).toContain(
      "Moved session.threadBindings.ttlHours → session.threadBindings.idleHours.",
    );
  });

  it("migrates channel threadBindings.ttlHours for root and account entries", () => {
    const result = migrateLegacyConfig({
      channels: {
        demo: {
          threadBindings: {
            ttlHours: 12,
          },
          accounts: {
            alpha: {
              threadBindings: {
                ttlHours: 6,
              },
            },
            beta: {
              threadBindings: {
                idleHours: 4,
                ttlHours: 9,
              },
            },
          },
        },
      },
    });

    expect(result.config).toBeNull();

    expect(result.changes).toContain(
      "Moved channels.demo.threadBindings.ttlHours → channels.demo.threadBindings.idleHours.",
    );
    expect(result.changes).toContain(
      "Moved channels.demo.accounts.alpha.threadBindings.ttlHours → channels.demo.accounts.alpha.threadBindings.idleHours.",
    );
    expect(result.changes).toContain(
      "Removed channels.demo.accounts.beta.threadBindings.ttlHours (channels.demo.accounts.beta.threadBindings.idleHours already set).",
    );
  });
});
