import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function hasLegacySessionMaintenance(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.prototype.hasOwnProperty.call(session, "maintenance"));
}

function hasLegacySessionWriteLock(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.prototype.hasOwnProperty.call(session, "writeLock"));
}

function hasLegacySessionStore(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.prototype.hasOwnProperty.call(session, "store"));
}

function hasLegacyParentForkMaxTokens(value: unknown): boolean {
  const session = getRecord(value);
  return Boolean(session && Object.prototype.hasOwnProperty.call(session, "parentForkMaxTokens"));
}

const LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.parentForkMaxTokens was removed; parent fork sizing is automatic. Run "openclaw doctor --fix" to remove it.',
  match: hasLegacyParentForkMaxTokens,
};

const LEGACY_SESSION_MAINTENANCE_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.maintenance is ignored with SQLite-backed sessions; run "openclaw doctor --fix" to remove it.',
  match: hasLegacySessionMaintenance,
};

const LEGACY_SESSION_WRITE_LOCK_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.writeLock is ignored because SQLite serializes session writes; run "openclaw doctor --fix" to remove it.',
  match: hasLegacySessionWriteLock,
};

const LEGACY_SESSION_STORE_RULE: LegacyConfigRule = {
  path: ["session"],
  message:
    'session.store is ignored because sessions live in per-agent SQLite databases; run "openclaw doctor --fix" to remove it.',
  match: hasLegacySessionStore,
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "session.store",
    describe: "Remove ignored legacy session.store settings",
    legacyRules: [LEGACY_SESSION_STORE_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.prototype.hasOwnProperty.call(session, "store")) {
        return;
      }
      delete session.store;
      changes.push("Removed ignored session.store; sessions live in per-agent SQLite databases.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.maintenance",
    describe: "Remove ignored session.maintenance settings",
    legacyRules: [LEGACY_SESSION_MAINTENANCE_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.prototype.hasOwnProperty.call(session, "maintenance")) {
        return;
      }
      delete session.maintenance;
      changes.push("Removed ignored session.maintenance; SQLite sessions do not prune rows.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.writeLock",
    describe: "Remove ignored session.writeLock settings",
    legacyRules: [LEGACY_SESSION_WRITE_LOCK_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.prototype.hasOwnProperty.call(session, "writeLock")) {
        return;
      }
      delete session.writeLock;
      changes.push("Removed ignored session.writeLock; SQLite serializes session writes.");
    },
  }),
  defineLegacyConfigMigration({
    id: "session.parentForkMaxTokens",
    describe: "Remove legacy session.parentForkMaxTokens",
    legacyRules: [LEGACY_SESSION_PARENT_FORK_MAX_TOKENS_RULE],
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session || !Object.prototype.hasOwnProperty.call(session, "parentForkMaxTokens")) {
        return;
      }
      delete session.parentForkMaxTokens;
      changes.push("Removed session.parentForkMaxTokens; parent fork sizing is automatic.");
    },
  }),
];
