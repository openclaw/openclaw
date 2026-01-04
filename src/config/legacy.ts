import type { LegacyConfigIssue } from "./types.js";

type LegacyConfigRule = {
  path: string[];
  message: string;
};

type LegacyConfigMigration = {
  id: string;
  describe: string;
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
};

const LEGACY_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["routing", "allowFrom"],
    message:
      "routing.allowFrom was removed; use whatsapp.allowFrom instead (run `clawdis doctor` to migrate).",
  },
  {
    path: ["routing", "groupChat", "requireMention"],
    message:
      'routing.groupChat.requireMention was removed; use whatsapp/telegram/imessage groups defaults (e.g. whatsapp.groups."*".requireMention) instead (run `clawdis doctor` to migrate).',
  },
  {
    path: ["telegram", "requireMention"],
    message:
      'telegram.requireMention was removed; use telegram.groups."*".requireMention instead (run `clawdis doctor` to migrate).',
  },
];

const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigration[] = [
  {
    id: "routing.allowFrom->whatsapp.allowFrom",
    describe: "Move routing.allowFrom to whatsapp.allowFrom",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const allowFrom = (routing as Record<string, unknown>).allowFrom;
      if (allowFrom === undefined) return;

      const whatsapp =
        raw.whatsapp && typeof raw.whatsapp === "object"
          ? (raw.whatsapp as Record<string, unknown>)
          : {};

      if (whatsapp.allowFrom === undefined) {
        whatsapp.allowFrom = allowFrom;
        changes.push("Moved routing.allowFrom → whatsapp.allowFrom.");
      } else {
        changes.push(
          "Removed routing.allowFrom (whatsapp.allowFrom already set).",
        );
      }

      delete (routing as Record<string, unknown>).allowFrom;
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      raw.whatsapp = whatsapp;
    },
  },
  {
    id: "routing.groupChat.requireMention->groups.*.requireMention",
    describe:
      "Move routing.groupChat.requireMention to whatsapp/telegram/imessage groups",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const groupChat =
        (routing as Record<string, unknown>).groupChat &&
        typeof (routing as Record<string, unknown>).groupChat === "object"
          ? ((routing as Record<string, unknown>).groupChat as Record<
              string,
              unknown
            >)
          : null;
      if (!groupChat) return;
      const requireMention = groupChat.requireMention;
      if (requireMention === undefined) return;

      const applyTo = (key: "whatsapp" | "telegram" | "imessage") => {
        const section =
          raw[key] && typeof raw[key] === "object"
            ? (raw[key] as Record<string, unknown>)
            : {};
        const groups =
          section.groups && typeof section.groups === "object"
            ? (section.groups as Record<string, unknown>)
            : {};
        const defaultKey = "*";
        const entry =
          groups[defaultKey] && typeof groups[defaultKey] === "object"
            ? (groups[defaultKey] as Record<string, unknown>)
            : {};
        if (entry.requireMention === undefined) {
          entry.requireMention = requireMention;
          groups[defaultKey] = entry;
          section.groups = groups;
          raw[key] = section;
          changes.push(
            `Moved routing.groupChat.requireMention → ${key}.groups."*".requireMention.`,
          );
        } else {
          changes.push(
            `Removed routing.groupChat.requireMention (${key}.groups."*" already set).`,
          );
        }
      };

      applyTo("whatsapp");
      applyTo("telegram");
      applyTo("imessage");

      delete groupChat.requireMention;
      if (Object.keys(groupChat).length === 0) {
        delete (routing as Record<string, unknown>).groupChat;
      }
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
    },
  },
  {
    id: "telegram.requireMention->telegram.groups.*.requireMention",
    describe:
      "Move telegram.requireMention to telegram.groups.*.requireMention",
    apply: (raw, changes) => {
      const telegram = raw.telegram;
      if (!telegram || typeof telegram !== "object") return;
      const requireMention = (telegram as Record<string, unknown>)
        .requireMention;
      if (requireMention === undefined) return;

      const groups =
        (telegram as Record<string, unknown>).groups &&
        typeof (telegram as Record<string, unknown>).groups === "object"
          ? ((telegram as Record<string, unknown>).groups as Record<
              string,
              unknown
            >)
          : {};
      const defaultKey = "*";
      const entry =
        groups[defaultKey] && typeof groups[defaultKey] === "object"
          ? (groups[defaultKey] as Record<string, unknown>)
          : {};

      if (entry.requireMention === undefined) {
        entry.requireMention = requireMention;
        groups[defaultKey] = entry;
        (telegram as Record<string, unknown>).groups = groups;
        changes.push(
          'Moved telegram.requireMention → telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed telegram.requireMention (telegram.groups."*" already set).',
        );
      }

      delete (telegram as Record<string, unknown>).requireMention;
      if (Object.keys(telegram as Record<string, unknown>).length === 0) {
        delete raw.telegram;
      }
    },
  },
];

export function findLegacyConfigIssues(raw: unknown): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of LEGACY_CONFIG_RULES) {
    let cursor: unknown = root;
    for (const key of rule.path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor !== undefined) {
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

export function applyLegacyMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") return { next: null, changes: [] };
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  if (changes.length === 0) return { next: null, changes: [] };
  return { next, changes };
}
