import { hasConfiguredSecretInput } from "../config/types.secrets.js";

export type FallbackChannelConvention = {
  configured?: (accountRecord: Record<string, unknown>) => boolean;
  details?: (accountRecord: Record<string, unknown>) => string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasTrimmedStringField(accountRecord: Record<string, unknown>, key: string): boolean {
  return typeof accountRecord[key] === "string" && accountRecord[key].trim().length > 0;
}

function hasConfiguredSecretField(accountRecord: Record<string, unknown>, key: string): boolean {
  return hasConfiguredSecretInput(accountRecord[key]);
}

export const FALLBACK_CHANNEL_CONVENTIONS: Record<string, FallbackChannelConvention> = {
  zulip: {
    configured: (accountRecord) =>
      hasTrimmedStringField(accountRecord, "botEmail") &&
      hasTrimmedStringField(accountRecord, "botApiKey") &&
      hasTrimmedStringField(accountRecord, "baseUrl"),
    details: (accountRecord) => {
      const details: string[] = [];
      if (hasTrimmedStringField(accountRecord, "botEmail")) {
        details.push(`email:${String(accountRecord.botEmail).trim()}`);
      }
      return details;
    },
  },
  twitch: {
    configured: (accountRecord) =>
      hasTrimmedStringField(accountRecord, "username") &&
      hasTrimmedStringField(accountRecord, "accessToken") &&
      hasTrimmedStringField(accountRecord, "clientId") &&
      hasTrimmedStringField(accountRecord, "channel"),
    details: (accountRecord) => {
      const details: string[] = [];
      if (hasTrimmedStringField(accountRecord, "username")) {
        details.push(`user:${String(accountRecord.username).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "channel")) {
        details.push(`channel:${String(accountRecord.channel).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "accessToken")) {
        details.push("token:config");
      }
      if (hasTrimmedStringField(accountRecord, "clientId")) {
        details.push("client:config");
      }
      return details;
    },
  },
  matrix: {
    configured: (accountRecord) =>
      hasTrimmedStringField(accountRecord, "homeserver") &&
      (hasTrimmedStringField(accountRecord, "accessToken") ||
        (hasTrimmedStringField(accountRecord, "userId") &&
          hasConfiguredSecretField(accountRecord, "password"))),
    details: (accountRecord) => {
      const details: string[] = [];
      if (hasTrimmedStringField(accountRecord, "userId")) {
        details.push(`user:${String(accountRecord.userId).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "homeserver")) {
        details.push(`homeserver:${String(accountRecord.homeserver).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "accessToken")) {
        details.push("token:config");
      } else if (hasConfiguredSecretField(accountRecord, "password")) {
        details.push("password:config");
      }
      return details;
    },
  },
  msteams: {
    configured: (accountRecord) =>
      hasTrimmedStringField(accountRecord, "appId") &&
      hasConfiguredSecretField(accountRecord, "appPassword") &&
      hasTrimmedStringField(accountRecord, "tenantId"),
    details: (accountRecord) => {
      const details: string[] = [];
      if (hasTrimmedStringField(accountRecord, "tenantId")) {
        details.push(`tenant:${String(accountRecord.tenantId).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "appId")) {
        details.push("app:config");
      }
      if (hasConfiguredSecretField(accountRecord, "appPassword")) {
        details.push("password:config");
      }
      return details;
    },
  },
  "synology-chat": {
    configured: (accountRecord) =>
      hasConfiguredSecretField(accountRecord, "token") &&
      hasTrimmedStringField(accountRecord, "incomingUrl"),
    details: (accountRecord) => {
      const details: string[] = [];
      if (hasTrimmedStringField(accountRecord, "botName")) {
        details.push(`bot:${String(accountRecord.botName).trim()}`);
      }
      if (hasTrimmedStringField(accountRecord, "nasHost")) {
        details.push(`nas:${String(accountRecord.nasHost).trim()}`);
      }
      if (hasConfiguredSecretField(accountRecord, "token")) {
        details.push("token:config");
      }
      if (hasTrimmedStringField(accountRecord, "incomingUrl")) {
        details.push("incoming:config");
      }
      return details;
    },
  },
};

export function resolveFallbackConventionConfigured(channelId: string, account: unknown): boolean | undefined {
  const accountRecord = asRecord(account);
  if (!accountRecord) {
    return undefined;
  }
  return FALLBACK_CHANNEL_CONVENTIONS[channelId]?.configured?.(accountRecord);
}

export function buildFallbackConventionDetails(channelId: string, account: unknown): string[] {
  const accountRecord = asRecord(account);
  if (!accountRecord) {
    return [];
  }
  return FALLBACK_CHANNEL_CONVENTIONS[channelId]?.details?.(accountRecord) ?? [];
}
