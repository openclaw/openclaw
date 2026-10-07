/** Tests command authorization owner defaults for direct-message senders. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveOwnerPromptNumbers } from "../agents/owner-display.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import type { OpenClawConfig } from "../config/config.js";
import { isResetAuthorizedForContext, resolveCommandAuthorization } from "./command-auth.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("senderIsOwner only reflects explicit owner authorization", () => {
  it.each([{ allowFrom: ["*"] }, { allowFrom: ["456"] }])(
    "suppresses command access without revoking owner identity for allowFrom $allowFrom",
    ({ allowFrom }) => {
      const cfg = { commands: { ownerAllowFrom: ["456"], allowFrom: { "*": allowFrom } } };
      const ctx = {
        Provider: "discord",
        Surface: "discord",
        SenderId: "456",
        CommandInterpretationSuppressed: true,
      };
      const params = { ctx, cfg, commandAuthorized: true };

      expect(resolveCommandAuthorization(params)).toMatchObject({
        senderId: "456",
        senderIsOwner: true,
        isAuthorizedSender: false,
      });
      expect(isResetAuthorizedForContext(params)).toBe(false);
      ctx.CommandInterpretationSuppressed = false;
      expect(resolveCommandAuthorization(params).isAuthorizedSender).toBe(true);
      expect(isResetAuthorizedForContext(params)).toBe(true);
    },
  );

  it.each<{
    name: string;
    cfg: OpenClawConfig;
    ctx: MsgContext;
    expected: Partial<ReturnType<typeof resolveCommandAuthorization>>;
  }>([
    ...(["direct", "group"] as const).map((chatType) => ({
      name: `does not treat ${chatType} senders as owners without ownerAllowFrom`,
      cfg: { channels: { discord: {} } },
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: chatType,
        From: "discord:123",
        SenderId: "123",
      },
      expected: { senderIsOwner: false, isAuthorizedSender: true },
    })),
    {
      name: "keeps channel-validated native group commands authorized without owner status",
      cfg: { channels: { telegram: {} } },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "telegram:group:-100123",
        SenderId: "200482621",
        CommandSource: "native",
      },
      expected: { senderIsOwner: false, isAuthorizedSender: true },
    },
    {
      name: "keeps channel allowlist senders authorized without owner status",
      cfg: { channels: { telegram: { allowFrom: ["200482621"] } } },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        From: "telegram:200482621",
        SenderId: "200482621",
      },
      expected: { ownerList: [], senderIsOwner: false, isAuthorizedSender: true },
    },
    {
      name: "denies owner identity when an explicit allowlist does not match",
      cfg: { channels: { discord: {} }, commands: { ownerAllowFrom: ["456"] } },
      ctx: { Provider: "discord", Surface: "discord", From: "discord:789", SenderId: "789" },
      expected: { senderIsOwner: false },
    },
    {
      name: "does not let native command authorization bypass explicit owner allowlists",
      cfg: { channels: { telegram: {} }, commands: { ownerAllowFrom: ["456"] } },
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "telegram:group:-100123",
        SenderId: "200482621",
        CommandSource: "native",
      },
      expected: { senderIsOwner: false, isAuthorizedSender: false },
    },
    {
      name: "grants owner identity when ownerAllowFrom matches sender",
      cfg: { channels: { discord: {} }, commands: { ownerAllowFrom: ["456"] } },
      ctx: { Provider: "discord", Surface: "discord", From: "discord:456", SenderId: "456" },
      expected: { senderIsOwner: true },
    },
    {
      name: "ignores ownerAllowFrom wildcards",
      cfg: { channels: { discord: {} }, commands: { ownerAllowFrom: ["*"] } },
      ctx: { Provider: "discord", Surface: "discord", From: "discord:anyone", SenderId: "anyone" },
      expected: { ownerList: [], senderIsOwner: false, isAuthorizedSender: true },
    },
    {
      name: "grants owner identity for internal operator.admin sessions",
      cfg: {},
      ctx: { Provider: "webchat", Surface: "webchat", GatewayClientScopes: ["operator.admin"] },
      expected: { senderIsOwner: true },
    },
  ])("$name", ({ cfg, ctx, expected }) => {
    expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true })).toMatchObject(
      expected,
    );
  });

  it("keeps a large owner allowlist authorized without exhausting the model prompt", () => {
    const ownerIds = Array.from({ length: 9_282 }, (_, index) =>
      String(100_000_000_000_000_000n + BigInt(index)),
    );
    const currentOwnerId = ownerIds.at(-1)!;
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ownerIds.map((ownerId) => `discord:${ownerId}`) },
    } as OpenClawConfig;
    const context = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${currentOwnerId}`,
      SenderId: `<@!${currentOwnerId}>`,
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });

    expect(auth.ownerList).toHaveLength(ownerIds.length);
    expect(auth.senderId).toBe(currentOwnerId);
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);

    const ownerNumbers = resolveOwnerPromptNumbers({
      ownerNumbers: auth.ownerList,
      senderId: auth.senderId,
      senderIsOwner: auth.senderIsOwner,
    });
    const promptParams = {
      workspaceDir: "/tmp/openclaw",
      ownerNumbers,
      runtimeInfo: { channel: "discord" },
    };
    const prompt = buildAgentSystemPrompt(promptParams);
    const ownerLine = prompt.split("## Authorized Senders\n")[1]?.split("\n")[0] ?? "";

    expect(ownerLine).toContain(currentOwnerId);
    expect(Buffer.byteLength(ownerLine, "utf8")).toBeLessThanOrEqual(1_024);

    const hashedPrompt = buildAgentSystemPrompt({ ...promptParams, ownerDisplay: "hash" });
    const currentOwnerHash = createHash("sha256").update(currentOwnerId).digest("hex").slice(0, 12);
    expect(hashedPrompt).toContain(currentOwnerHash);
    expect(hashedPrompt).not.toContain(currentOwnerId);

    cfg.commands?.ownerAllowFrom?.pop();
    const revoked = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });
    expect(revoked.ownerList).toHaveLength(ownerIds.length - 1);
    expect(revoked.senderIsOwner).toBe(false);
    expect(revoked.isAuthorizedSender).toBe(false);
  });
});
