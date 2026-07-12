/**
 * Composed real-resolver coverage for #104984: drives the actual
 * resolveCommandAuthorization (registry fixture, no mock) through
 * handleAllowlistCommand's cross-channel guard. Origin-fallback and
 * channel/guild context owners must be blocked at the guard for a cross-channel
 * write; only configured global owners pass it.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { installDiscordRegistryHooks } from "../test-helpers/command-auth-registry-fixture.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import type { HandleCommandsParams } from "./commands-types.js";

installDiscordRegistryHooks();

async function runDiscordToWhatsappAdd(cfg: OpenClawConfig, ctx: MsgContext) {
  // Real resolver computes origin authorization exactly as production does.
  const auth = resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
  const params = {
    cfg,
    ctx,
    command: {
      surface: "discord",
      channel: "discord",
      channelId: "discord",
      ownerList: auth.ownerList,
      senderIsOwner: auth.senderIsOwner,
      senderIsGlobalOwner: auth.senderIsGlobalOwner,
      isAuthorizedSender: true,
      senderId: auth.senderId,
      rawBodyNormalized: "/allowlist add dm --channel whatsapp +15551234567",
      commandBodyNormalized: "/allowlist add dm --channel whatsapp +15551234567",
    },
  } as unknown as HandleCommandsParams;

  const result = await handleAllowlistCommand(params, true);
  // The guard denies non-native turns with shouldContinue:false and no reply,
  // before any channel/config work; anything else means the guard was passed.
  const blockedAtGuard = result?.shouldContinue === false && result?.reply === undefined;
  return { auth, blockedAtGuard };
}

const DISCORD_CTX = {
  Provider: "discord",
  Surface: "discord",
  From: "discord:123",
  SenderId: "123",
} as MsgContext;

describe("handleAllowlistCommand cross-channel guard (real resolver, #104984)", () => {
  it("blocks an origin allowFrom fallback owner from a cross-channel write", async () => {
    const { auth, blockedAtGuard } = await runDiscordToWhatsappAdd(
      {
        commands: { config: true },
        channels: { discord: { allowFrom: ["123"] }, whatsapp: { allowFrom: ["+15550000000"] } },
      } as OpenClawConfig,
      DISCORD_CTX,
    );
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsGlobalOwner).toBe(false);
    expect(blockedAtGuard).toBe(true);
  });

  it("blocks a channel/guild context owner from a cross-channel write", async () => {
    const { auth, blockedAtGuard } = await runDiscordToWhatsappAdd(
      {
        commands: { config: true },
        channels: { discord: {}, whatsapp: { allowFrom: ["+15550000000"] } },
      } as OpenClawConfig,
      { ...DISCORD_CTX, OwnerAllowFrom: ["123"] } as MsgContext,
    );
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.senderIsGlobalOwner).toBe(false);
    // The origin guild/channel OwnerAllowFrom must not be reused to authorize
    // the sender as a WhatsApp owner during the target re-check.
    expect(blockedAtGuard).toBe(true);
  });

  it("lets a configured global owner pass the cross-channel guard", async () => {
    const { auth, blockedAtGuard } = await runDiscordToWhatsappAdd(
      {
        commands: { config: true, ownerAllowFrom: ["123"] },
        channels: { discord: { allowFrom: ["123"] }, whatsapp: { allowFrom: ["+15550000000"] } },
      } as OpenClawConfig,
      DISCORD_CTX,
    );
    expect(auth.senderIsGlobalOwner).toBe(true);
    expect(blockedAtGuard).toBe(false);
  });
});
