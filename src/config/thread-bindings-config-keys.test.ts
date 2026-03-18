import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";
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

  it("rejects legacy channels.discord.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
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
        path: "channels.discord.threadBindings",
        message: expect.stringContaining("ttlHours"),
      }),
    );
  });

  it("rejects legacy channels.discord.accounts.<id>.threadBindings.ttlHours", () => {
    const result = validateConfigObjectRaw({
      channels: {
        discord: {
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
        path: "channels.discord.accounts",
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

  it("migrates Discord threadBindings.ttlHours for root and account entries", () => {
    const result = migrateLegacyConfig({
      channels: {
        discord: {
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

    const discord = result.config?.channels?.discord;
    expect(discord?.threadBindings?.idleHours).toBe(12);
    expect(
      (discord?.threadBindings as Record<string, unknown> | undefined)?.ttlHours,
    ).toBeUndefined();

    expect(discord?.accounts?.alpha?.threadBindings?.idleHours).toBe(6);
    expect(
      (discord?.accounts?.alpha?.threadBindings as Record<string, unknown> | undefined)?.ttlHours,
    ).toBeUndefined();

    expect(discord?.accounts?.beta?.threadBindings?.idleHours).toBe(4);
    expect(
      (discord?.accounts?.beta?.threadBindings as Record<string, unknown> | undefined)?.ttlHours,
    ).toBeUndefined();

    expect(result.changes).toContain(
      "Moved channels.discord.threadBindings.ttlHours → channels.discord.threadBindings.idleHours.",
    );
    expect(result.changes).toContain(
      "Moved channels.discord.accounts.alpha.threadBindings.ttlHours → channels.discord.accounts.alpha.threadBindings.idleHours.",
    );
    expect(result.changes).toContain(
      "Removed channels.discord.accounts.beta.threadBindings.ttlHours (channels.discord.accounts.beta.threadBindings.idleHours already set).",
    );
  });
});
