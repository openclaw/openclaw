// Defines Google Chat channel configuration types from the canonical schema.
import type { z } from "zod";
import type { CommonChannelMessagingConfig } from "./types.channel-messaging-common.js";
import type { GoogleChatConfigSchema } from "./zod-schema.providers-googlechat.js";

type GoogleChatSchemaInput = z.input<typeof GoogleChatConfigSchema>;
type GoogleChatAccountSchemaInput = Omit<GoogleChatSchemaInput, "accounts" | "defaultAccount">;

export type GoogleChatGroupConfig = NonNullable<
  NonNullable<GoogleChatAccountSchemaInput["groups"]>[string]
>;

type GoogleChatCompatibilityConfig = Pick<CommonChannelMessagingConfig, "dms" | "heartbeat">;

export type GoogleChatAccountConfig = Omit<GoogleChatAccountSchemaInput, "groups" | "dms"> &
  GoogleChatCompatibilityConfig & { groups?: Record<string, GoogleChatGroupConfig> };

export type GoogleChatConfig = Omit<GoogleChatSchemaInput, "accounts" | "groups" | "dms"> &
  GoogleChatAccountConfig & {
    accounts?: Record<string, GoogleChatAccountConfig>;
  };

export type GoogleChatDmConfig = NonNullable<GoogleChatAccountConfig["dm"]>;
