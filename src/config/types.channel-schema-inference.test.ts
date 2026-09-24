import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channel-health.js";
import type { GoogleChatAccountConfig, GoogleChatConfig } from "./types.googlechat.js";
import type { DmConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";
import type {
  WhatsAppAccountConfig,
  WhatsAppConfig,
  WhatsAppGroupConfig,
  WhatsAppReactionLevel,
} from "./types.whatsapp.js";
import {
  buildChannelAllowBotsSchema,
  buildChannelReactionShape,
} from "./zod-schema.channel-messaging-common.js";

type WhatsAppReactionLevelContract = "off" | "ack" | "minimal" | "extensive";
type Equal<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

type _GoogleChatAllowBots = Assert<
  Equal<NonNullable<GoogleChatAccountConfig["allowBots"]>, boolean>
>;
type _GoogleChatDms = Assert<Equal<NonNullable<GoogleChatAccountConfig["dms"]>[string], DmConfig>>;
type _GoogleChatAccountHeartbeat = Assert<
  Equal<NonNullable<GoogleChatAccountConfig["heartbeat"]>, ChannelHeartbeatVisibilityConfig>
>;
type _GoogleChatRootHeartbeat = Assert<
  Equal<NonNullable<GoogleChatConfig["heartbeat"]>, ChannelHeartbeatVisibilityConfig>
>;
type _WhatsAppReactionLevel = Assert<Equal<WhatsAppReactionLevel, WhatsAppReactionLevelContract>>;
type _WhatsAppAccountReactionLevel = Assert<
  Equal<NonNullable<WhatsAppAccountConfig["reactionLevel"]>, WhatsAppReactionLevelContract>
>;
type _WhatsAppRootReactionLevel = Assert<
  Equal<NonNullable<WhatsAppConfig["reactionLevel"]>, WhatsAppReactionLevelContract>
>;
type _WhatsAppDms = Assert<Equal<NonNullable<WhatsAppAccountConfig["dms"]>[string], DmConfig>>;
type _WhatsAppToolsBySender = Assert<
  Equal<NonNullable<WhatsAppGroupConfig["toolsBySender"]>, GroupToolPolicyBySenderConfig>
>;
type _WhatsAppAccountHeartbeat = Assert<
  Equal<NonNullable<WhatsAppAccountConfig["heartbeat"]>, ChannelHeartbeatVisibilityConfig>
>;
type _WhatsAppRootHeartbeat = Assert<
  Equal<NonNullable<WhatsAppConfig["heartbeat"]>, ChannelHeartbeatVisibilityConfig>
>;

const booleanAllowBotsOptions: { allowMentions?: boolean } = {};
const allowBotsSchemas = {
  empty: buildChannelAllowBotsSchema({}),
  false: buildChannelAllowBotsSchema({ allowMentions: false }),
  undefined: buildChannelAllowBotsSchema(undefined),
  optional: buildChannelAllowBotsSchema(booleanAllowBotsOptions),
  dynamic: buildChannelAllowBotsSchema({ allowMentions: Boolean(0) }),
};
type _AllowBotsEmpty = Assert<
  Equal<z.input<(typeof allowBotsSchemas)["empty"]>, boolean | undefined>
>;
type _AllowBotsFalse = Assert<
  Equal<z.input<(typeof allowBotsSchemas)["false"]>, boolean | undefined>
>;
type _AllowBotsUndefined = Assert<
  Equal<z.input<(typeof allowBotsSchemas)["undefined"]>, boolean | undefined>
>;
type _AllowBotsOptional = Assert<
  Equal<z.input<(typeof allowBotsSchemas)["optional"]>, boolean | "mentions" | undefined>
>;
type _AllowBotsDynamic = Assert<
  Equal<z.input<(typeof allowBotsSchemas)["dynamic"]>, boolean | "mentions" | undefined>
>;

const optionalReactionOptions: {
  reactionLevels?: readonly ["off", "ack"];
  reactionAllowlist?: boolean;
} = {};
const emptyReactionSchema = z.object(buildChannelReactionShape({}));
const falseReactionSchema = z.object(buildChannelReactionShape({ reactionAllowlist: false }));
const optionalReactionSchema = z.object(buildChannelReactionShape(optionalReactionOptions));

describe("schema-derived channel config types", () => {
  it("preserves channel-specific helper inference", () => {
    expect(emptyReactionSchema.parse({})).toEqual({});
    expect(falseReactionSchema.parse({})).toEqual({});
    expect(optionalReactionSchema.parse({})).toEqual({});
    expect(true).toBe(true);
  });
});
