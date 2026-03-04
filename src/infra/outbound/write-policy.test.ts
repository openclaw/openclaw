import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { installResolveOutboundTargetPluginRegistryHooks } from "./targets.shared-test.js";
import {
  buildProtectedDestinationMap,
  decideWrite,
  getProtectedDestinationMap,
  guardWrite,
  resetProtectedDestinationMapCacheForTests,
} from "./write-policy.js";

describe("write policy", () => {
  installResolveOutboundTargetPluginRegistryHooks();

  beforeEach(() => {
    resetProtectedDestinationMapCacheForTests();
  });

  it("redirects an exact protected destination", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
              accountId: "OPS",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                accountId: "WORK",
                chatId: "(555) 123-4567",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+5551234567",
        accountId: "work",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision).toEqual({
      kind: "redirect",
      target: {
        channel: "telegram",
        to: "123456789",
        accountId: "ops",
      },
    });
  });

  it("redirects via wildcard account match", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                chatId: "+15551230000",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15551230000",
        accountId: "other",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision).toEqual({
      kind: "redirect",
      target: {
        channel: "telegram",
        to: "123456789",
        accountId: "default",
      },
    });
  });

  it("suppresses side-effect actions for protected destinations", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                chatId: "+15551230000",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "typing",
      {
        channel: "whatsapp",
        to: "+15551230000",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision).toEqual({ kind: "suppress" });
  });

  it("denies protected destinations when no relay target exists", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          rules: [
            {
              mode: "read-only",
              match: {
                channel: "whatsapp",
                chatId: "+15551230000",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15551230000",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain('without "relayTo"');
    }
  });

  it("allows unprotected destinations", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                chatId: "+15551230000",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15559870000",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision).toEqual({ kind: "allow" });
  });

  it("protects channel-level scope when chatId is omitted", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                accountId: "work",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15557654321",
        accountId: "WORK",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision.kind).toBe("redirect");
  });

  it("denies by default when relayRouting.defaultMode is read-only", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          defaultMode: "read-only",
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15551230000",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision.kind).toBe("deny");
  });

  it("reuses map cache per config object and rebuilds for new config identity", () => {
    const cfgA: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                chatId: "+15550000001",
              },
            },
          ],
        },
      },
    };

    const cfgB: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "whatsapp",
                chatId: "+15550000002",
              },
            },
          ],
        },
      },
    };

    const first = getProtectedDestinationMap(cfgA);
    const second = getProtectedDestinationMap(cfgA);
    const third = getProtectedDestinationMap(cfgB);

    expect(second).toBe(first);
    expect(third).not.toBe(first);

    const staleCheck = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15550000001",
      },
      third,
    );
    expect(staleCheck).toEqual({ kind: "allow" });
  });

  it("canonicalizes destinations using outbound target resolution behavior", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: {
              channel: "telegram",
              to: "123456789",
            },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "WhatsApp",
                accountId: "WORK",
                chatId: " WhatsApp:120363401234567890@G.US ",
              },
            },
          ],
        },
      },
    };

    const decision = decideWrite(
      "send",
      {
        channel: "whatsapp",
        to: "120363401234567890@g.us",
        accountId: "work",
      },
      buildProtectedDestinationMap(cfg),
    );

    expect(decision.kind).toBe("redirect");
  });

  it("guardWrite returns true when action is allowed", () => {
    const cfg: OpenClawConfig = {};
    const allowed = guardWrite(
      "typing",
      {
        channel: "whatsapp",
        to: "+15559870000",
      },
      buildProtectedDestinationMap(cfg),
    );
    expect(allowed).toBe(true);
  });

  it("guardWrite suppresses protected side-effect writes", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "telegram", to: "123456789" },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: { channel: "whatsapp", chatId: "+15551230000" },
            },
          ],
        },
      },
    };
    const allowed = guardWrite(
      "typing",
      {
        channel: "whatsapp",
        to: "+15551230000",
      },
      buildProtectedDestinationMap(cfg),
    );
    expect(allowed).toBe(false);
  });

  it("guardWrite blocks redirect decisions at helper level", () => {
    const cfg: OpenClawConfig = {
      session: {
        relayRouting: {
          targets: {
            ops: { channel: "telegram", to: "123456789" },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: { channel: "whatsapp", chatId: "+15551230000" },
            },
          ],
        },
      },
    };
    const allowed = guardWrite(
      "send",
      {
        channel: "whatsapp",
        to: "+15551230000",
      },
      buildProtectedDestinationMap(cfg),
    );
    expect(allowed).toBe(false);
  });
});
