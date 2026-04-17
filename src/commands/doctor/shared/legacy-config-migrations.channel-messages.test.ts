import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

function migrateLegacyConfigForTest(raw: unknown): {
  config: OpenClawConfig | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { config: null, changes: [] };
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  return changes.length === 0
    ? { config: null, changes }
    : { config: next as OpenClawConfig, changes };
}

describe("legacy migrate channels.<id>.messages.* misplacement (issue #67859)", () => {
  it("does nothing when no channel carries a misplaced messages block", () => {
    const res = migrateLegacyConfigForTest({
      messages: { ackReaction: "👀" },
      channels: {
        telegram: {
          ackReaction: "👀",
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("lifts telegram reaction config from channels.telegram.messages to the correct locations", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        telegram: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
            removeAckAfterReply: true,
            statusReactions: {
              enabled: true,
              emojis: { thinking: "🤔", done: "👍", error: "💔" },
            },
          },
        },
      },
    });

    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.telegram.messages.ackReaction → channels.telegram.ackReaction.",
        "Moved channels.telegram.messages.ackReactionScope → messages.ackReactionScope.",
        "Moved channels.telegram.messages.removeAckAfterReply → messages.removeAckAfterReply.",
        "Moved channels.telegram.messages.statusReactions → messages.statusReactions.",
      ]),
    );

    const cfg = res.config as {
      messages?: {
        ackReactionScope?: string;
        removeAckAfterReply?: boolean;
        statusReactions?: { enabled?: boolean };
      };
      channels?: {
        telegram?: {
          ackReaction?: string;
          messages?: unknown;
        };
      };
    };

    // Channel-scoped keys land on the channel scalar.
    expect(cfg.channels?.telegram?.ackReaction).toBe("👀");
    // Global-only keys land at the top level.
    expect(cfg.messages?.ackReactionScope).toBe("all");
    expect(cfg.messages?.removeAckAfterReply).toBe(true);
    expect(cfg.messages?.statusReactions?.enabled).toBe(true);
    // The misplaced container is removed when emptied.
    expect(cfg.channels?.telegram?.messages).toBeUndefined();
  });

  it("lifts account-level messages blocks (channels.<id>.accounts.<aid>.messages.*)", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        telegram: {
          accounts: {
            main: {
              messages: {
                ackReaction: "🦞",
                responsePrefix: "[main]",
                statusReactions: { enabled: true },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.telegram.accounts.main.messages.ackReaction → channels.telegram.accounts.main.ackReaction.",
        "Moved channels.telegram.accounts.main.messages.responsePrefix → channels.telegram.accounts.main.responsePrefix.",
        "Moved channels.telegram.accounts.main.messages.statusReactions → messages.statusReactions.",
      ]),
    );

    const cfg = res.config as {
      messages?: { statusReactions?: { enabled?: boolean } };
      channels?: {
        telegram?: {
          accounts?: Record<
            string,
            {
              ackReaction?: string;
              responsePrefix?: string;
              messages?: unknown;
            }
          >;
        };
      };
    };

    expect(cfg.channels?.telegram?.accounts?.main?.ackReaction).toBe("🦞");
    expect(cfg.channels?.telegram?.accounts?.main?.responsePrefix).toBe("[main]");
    expect(cfg.channels?.telegram?.accounts?.main?.messages).toBeUndefined();
    expect(cfg.messages?.statusReactions?.enabled).toBe(true);
  });

  it("honors existing destination values and removes the misplaced key with a note", () => {
    const res = migrateLegacyConfigForTest({
      messages: {
        ackReactionScope: "group-mentions",
      },
      channels: {
        telegram: {
          ackReaction: "🦐",
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
        },
      },
    });

    expect(res.changes).toEqual(
      expect.arrayContaining([
        "Removed channels.telegram.messages.ackReaction (channels.telegram.ackReaction already set).",
        "Removed channels.telegram.messages.ackReactionScope (messages.ackReactionScope already set).",
      ]),
    );

    const cfg = res.config as {
      messages?: { ackReactionScope?: string };
      channels?: {
        telegram?: {
          ackReaction?: string;
          messages?: unknown;
        };
      };
    };

    expect(cfg.channels?.telegram?.ackReaction).toBe("🦐");
    expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
    expect(cfg.channels?.telegram?.messages).toBeUndefined();
  });

  it("leaves unknown nested keys in place so third-party plugin config is not touched", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        customChannel: {
          messages: {
            ackReaction: "👀",
            someThirdPartyKey: { foo: "bar" },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.customChannel.messages.ackReaction → channels.customChannel.ackReaction.",
    );

    const cfg = res.config as {
      channels?: {
        customChannel?: {
          ackReaction?: string;
          messages?: { someThirdPartyKey?: { foo?: string } };
        };
      };
    };

    expect(cfg.channels?.customChannel?.ackReaction).toBe("👀");
    expect(cfg.channels?.customChannel?.messages?.someThirdPartyKey).toEqual({ foo: "bar" });
  });

  it("does not clobber a non-record top-level messages value", () => {
    const res = migrateLegacyConfigForTest({
      messages: "invalid-scalar",
      channels: {
        telegram: {
          messages: {
            ackReaction: "👀",
            ackReactionScope: "all",
          },
        },
      },
    });

    // Channel-scoped keys still lift onto the channel scalar.
    expect(res.changes).toContain(
      "Moved channels.telegram.messages.ackReaction → channels.telegram.ackReaction.",
    );
    // Global-only keys are left under the misplaced block so the operator can
    // fix the invalid top-level `messages` first.
    expect(res.changes).not.toContain(
      "Moved channels.telegram.messages.ackReactionScope → messages.ackReactionScope.",
    );

    const cfg = res.config as {
      messages?: unknown;
      channels?: {
        telegram?: {
          ackReaction?: string;
          messages?: { ackReactionScope?: string };
        };
      };
    };

    expect(cfg.messages).toBe("invalid-scalar");
    expect(cfg.channels?.telegram?.ackReaction).toBe("👀");
    expect(cfg.channels?.telegram?.messages?.ackReactionScope).toBe("all");
  });

  it("skips channels.defaults and channels.modelByChannel", () => {
    const res = migrateLegacyConfigForTest({
      channels: {
        defaults: {
          messages: { ackReaction: "👀" },
        },
        modelByChannel: {
          messages: { ackReaction: "👀" },
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
});
