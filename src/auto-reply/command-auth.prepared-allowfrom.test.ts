/** Tests that large owner allowlists stay correct once compiled per config array. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

function makeCtx(senderId: string): MsgContext {
  return {
    Provider: "discord",
    Surface: "discord",
    ChatType: "direct",
    From: `discord:${senderId}`,
    SenderId: senderId,
  } as MsgContext;
}

describe("owner allowlist preparation", () => {
  it("authorizes an owner anywhere in a large allowlist across repeated messages", () => {
    // The prepared list is cached on the raw config array identity, so a second
    // message for the same config must not observe a stale or truncated list.
    const ownerAllowFrom = Array.from({ length: 2000 }, (_, i) => `discord:${i}`);
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom },
    } as unknown as OpenClawConfig;

    for (const senderId of ["0", "1999", "1000"]) {
      const auth = resolveCommandAuthorization({
        ctx: makeCtx(senderId),
        cfg,
        commandAuthorized: true,
      });
      expect(auth.senderIsOwner).toBe(true);
    }

    const stranger = resolveCommandAuthorization({
      ctx: makeCtx("2000"),
      cfg,
      commandAuthorized: true,
    });
    expect(stranger.senderIsOwner).toBe(false);
  });

  it("keeps separate results for two configs that share entry values", () => {
    // Distinct raw arrays must get distinct cache slots even with equal contents.
    const first = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["discord:alice"] },
    } as unknown as OpenClawConfig;
    const second = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["discord:bob"] },
    } as unknown as OpenClawConfig;

    expect(
      resolveCommandAuthorization({ ctx: makeCtx("alice"), cfg: first, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(true);
    expect(
      resolveCommandAuthorization({ ctx: makeCtx("alice"), cfg: second, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(false);
    expect(
      resolveCommandAuthorization({ ctx: makeCtx("bob"), cfg: second, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(true);
  });

  it("does not let one provider read another's compiled scope from a shared array", () => {
    // Compiled scopes are cached per (providerId, plugin id, accountId). This guards
    // that they are keyed at all rather than shared process-wide for one config
    // array: collapsing the key makes telegram inherit discord's owner list and this
    // assertion flips. It does not isolate providerId on its own — the discord-only
    // registry fixture makes plugin id co-vary with it.
    const cfg = {
      channels: { discord: {}, telegram: {} },
      commands: { ownerAllowFrom: ["discord:alice", "telegram:bob"] },
    } as unknown as OpenClawConfig;

    const discordAlice = resolveCommandAuthorization({
      ctx: makeCtx("alice"),
      cfg,
      commandAuthorized: true,
    });
    const telegramAlice = resolveCommandAuthorization({
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        From: "telegram:alice",
        SenderId: "alice",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(discordAlice.senderIsOwner).toBe(true);
    expect(telegramAlice.senderIsOwner).toBe(false);
  });

  it("authorizes correctly for two configs holding the same ownerAllowFrom array", () => {
    // Shallow config merges ({...cfg}) give a new config object the same nested
    // array. This pins end-to-end behavior for that shape. It does NOT isolate the
    // cfg dimension of the cache key: both configs here format identically, so it
    // passes with or without cfg-identity scoping (verified). Isolating that needs
    // a plugin whose formatAllowFrom reads a differing cfg field.
    const shared = ["discord:alice"];
    const base = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: shared },
    } as unknown as OpenClawConfig;
    const merged = { ...base } as unknown as OpenClawConfig;

    expect(base.commands?.ownerAllowFrom).toBe(merged.commands?.ownerAllowFrom);
    expect(
      resolveCommandAuthorization({ ctx: makeCtx("alice"), cfg: base, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(true);
    expect(
      resolveCommandAuthorization({ ctx: makeCtx("alice"), cfg: merged, commandAuthorized: true })
        .senderIsOwner,
    ).toBe(true);
  });

  it("still honors a wildcard owner entry after preparation", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["*"] },
    } as unknown as OpenClawConfig;

    // Wildcards are stripped from the owner identity list, so a wildcard alone
    // must not silently promote an arbitrary sender to owner.
    const auth = resolveCommandAuthorization({
      ctx: makeCtx("anyone"),
      cfg,
      commandAuthorized: true,
    });
    expect(auth.senderIsOwner).toBe(false);
  });
});
