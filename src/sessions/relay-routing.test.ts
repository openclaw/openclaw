import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveRelayRoute } from "./relay-routing.js";

describe("resolveRelayRoute", () => {
  it("defaults to read-write when relayRouting is not configured", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveRelayRoute({ cfg }).mode).toBe("read-write");
  });

  it("uses first-match semantics when multiple rules match", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C123" },
          },
          rules: [
            { mode: "read-write", match: { channel: "discord" } },
            { mode: "read-only", relayTo: "ops", match: { channel: "discord" } },
          ],
        },
      },
    } as OpenClawConfig;

    expect(resolveRelayRoute({ cfg, channel: "discord" }).mode).toBe("read-write");
  });

  it("matches keyPrefix against stripped session keys", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C123" },
          },
          rules: [{ mode: "read-only", relayTo: "ops", match: { keyPrefix: "discord:group:" } }],
        },
      },
    } as OpenClawConfig;

    expect(resolveRelayRoute({ cfg, sessionKey: "agent:main:discord:group:dev" }).mode).toBe(
      "read-only",
    );
    expect(resolveRelayRoute({ cfg, sessionKey: "agent:main:slack:group:dev" }).mode).toBe(
      "read-write",
    );
  });

  it("matches rawKeyPrefix against the full agent-prefixed session key", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C123" },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: { rawKeyPrefix: "agent:main:discord:" },
            },
          ],
        },
      },
    } as OpenClawConfig;

    expect(resolveRelayRoute({ cfg, sessionKey: "agent:main:discord:group:dev" }).mode).toBe(
      "read-only",
    );
    expect(resolveRelayRoute({ cfg, sessionKey: "discord:group:dev" }).mode).toBe("read-write");
  });

  it("normalizes chatType matching (dm and direct are equivalent)", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C123" },
          },
          rules: [{ mode: "read-only", relayTo: "ops", match: { chatType: "direct" } }],
        },
      },
    } as OpenClawConfig;

    expect(resolveRelayRoute({ cfg, chatType: "dm" }).mode).toBe("read-only");
    expect(resolveRelayRoute({ cfg, chatType: "mystery-type" }).mode).toBe("read-write");
  });

  it('falls back to read-write when defaultMode is "read-only" and targets are ambiguous', () => {
    const noTargets = {
      session: { relayRouting: { defaultMode: "read-only" } },
    } as OpenClawConfig;
    expect(resolveRelayRoute({ cfg: noTargets }).mode).toBe("read-write");

    const multipleTargets = {
      session: {
        relayRouting: {
          defaultMode: "read-only",
          targets: {
            one: { channel: "slack", to: "C1" },
            two: { channel: "slack", to: "C2" },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveRelayRoute({ cfg: multipleTargets }).mode).toBe("read-write");
  });

  it('uses the lone target when defaultMode is "read-only" and exactly one target exists', () => {
    const cfg = {
      session: {
        relayRouting: {
          defaultMode: "read-only",
          targets: {
            ops: { channel: "slack", to: "C123", accountId: "work", threadId: "1717.99" },
          },
        },
      },
    } as OpenClawConfig;

    const route = resolveRelayRoute({ cfg });
    expect(route.mode).toBe("read-only");
    if (route.mode === "read-only") {
      expect(route.target).toEqual({
        channel: "slack",
        to: "C123",
        accountId: "work",
        threadId: "1717.99",
      });
    }
  });

  it("captures live source metadata separately from read-only relay target routing", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C_TARGET", accountId: "ops", threadId: "T_TARGET" },
          },
          rules: [{ mode: "read-only", relayTo: "ops", match: { channel: "discord" } }],
        },
      },
    } as OpenClawConfig;

    const route = resolveRelayRoute({
      cfg,
      channel: "discord",
      sessionKey: "agent:main:discord:group:123",
      source: {
        to: "SOURCE_TO",
        accountId: "SOURCE_ACCOUNT",
        threadId: "SOURCE_THREAD",
      },
    });

    expect(route.mode).toBe("read-only");
    if (route.mode === "read-only") {
      expect(route.target).toEqual({
        channel: "slack",
        to: "C_TARGET",
        accountId: "ops",
        threadId: "T_TARGET",
      });
      expect(route.source).toEqual({
        channel: "discord",
        chatType: undefined,
        sessionKey: "agent:main:discord:group:123",
        to: "SOURCE_TO",
        accountId: "SOURCE_ACCOUNT",
        threadId: "SOURCE_THREAD",
      });
    }
  });

  it("prefers explicit live channel input over channel inferred from sessionKey", () => {
    const cfg = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "slack", to: "C123" },
          },
          rules: [{ mode: "read-only", relayTo: "ops", match: { channel: "discord" } }],
        },
      },
    } as OpenClawConfig;

    const route = resolveRelayRoute({
      cfg,
      channel: "discord",
      sessionKey: "agent:main:slack:group:dev",
    });
    expect(route.mode).toBe("read-only");
  });
});
