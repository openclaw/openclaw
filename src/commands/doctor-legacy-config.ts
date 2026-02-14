import type { OpenClawConfig } from "../config/config.js";
export function normalizeLegacyConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: OpenClawConfig = cfg;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const normalizeDmAliases = (params: {
    provider: "slack" | "discord";
    entry: Record<string, unknown>;
    pathPrefix: string;
  }): { entry: Record<string, unknown>; changed: boolean } => {
    let changed = false;
    let updated: Record<string, unknown> = params.entry;
    const rawDm = updated.dm;
    const dm = isRecord(rawDm) ? structuredClone(rawDm) : null;
    let dmChanged = false;

    const allowFromEqual = (a: unknown, b: unknown): boolean => {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return false;
      }
      const na = a.map((v) => String(v).trim()).filter(Boolean);
      const nb = b.map((v) => String(v).trim()).filter(Boolean);
      if (na.length !== nb.length) {
        return false;
      }
      return na.every((v, i) => v === nb[i]);
    };

    const topDmPolicy = updated.dmPolicy;
    const legacyDmPolicy = dm?.policy;
    if (topDmPolicy === undefined && legacyDmPolicy !== undefined) {
      updated = { ...updated, dmPolicy: legacyDmPolicy };
      changed = true;
      if (dm) {
        delete dm.policy;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.policy → ${params.pathPrefix}.dmPolicy.`);
    } else if (topDmPolicy !== undefined && legacyDmPolicy !== undefined) {
      if (topDmPolicy === legacyDmPolicy) {
        if (dm) {
          delete dm.policy;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.policy (dmPolicy already set).`);
        }
      }
    }

    const topAllowFrom = updated.allowFrom;
    const legacyAllowFrom = dm?.allowFrom;
    if (topAllowFrom === undefined && legacyAllowFrom !== undefined) {
      updated = { ...updated, allowFrom: legacyAllowFrom };
      changed = true;
      if (dm) {
        delete dm.allowFrom;
        dmChanged = true;
      }
      changes.push(`Moved ${params.pathPrefix}.dm.allowFrom → ${params.pathPrefix}.allowFrom.`);
    } else if (topAllowFrom !== undefined && legacyAllowFrom !== undefined) {
      if (allowFromEqual(topAllowFrom, legacyAllowFrom)) {
        if (dm) {
          delete dm.allowFrom;
          dmChanged = true;
          changes.push(`Removed ${params.pathPrefix}.dm.allowFrom (allowFrom already set).`);
        }
      }
    }

    if (dm && isRecord(rawDm) && dmChanged) {
      const keys = Object.keys(dm);
      if (keys.length === 0) {
        if (updated.dm !== undefined) {
          const { dm: _ignored, ...rest } = updated;
          updated = rest;
          changed = true;
          changes.push(`Removed empty ${params.pathPrefix}.dm after migration.`);
        }
      } else {
        updated = { ...updated, dm };
        changed = true;
      }
    }

    return { entry: updated, changed };
  };

  const normalizeProvider = (provider: "slack" | "discord") => {
    const channels = next.channels as Record<string, unknown> | undefined;
    const rawEntry = channels?.[provider];
    if (!isRecord(rawEntry)) {
      return;
    }

    const base = normalizeDmAliases({
      provider,
      entry: rawEntry,
      pathPrefix: `channels.${provider}`,
    });
    let updated = base.entry;
    let changed = base.changed;

    const rawAccounts = updated.accounts;
    if (isRecord(rawAccounts)) {
      let accountsChanged = false;
      const accounts = { ...rawAccounts };
      for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
        if (!isRecord(rawAccount)) {
          continue;
        }
        const res = normalizeDmAliases({
          provider,
          entry: rawAccount,
          pathPrefix: `channels.${provider}.accounts.${accountId}`,
        });
        if (res.changed) {
          accounts[accountId] = res.entry;
          accountsChanged = true;
        }
      }
      if (accountsChanged) {
        updated = { ...updated, accounts };
        changed = true;
      }
    }

    if (changed) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          [provider]: updated as unknown,
        },
      };
    }
  };

  normalizeProvider("slack");
  normalizeProvider("discord");

  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  const hasWhatsAppConfig = cfg.channels?.whatsapp !== undefined;
  if (legacyAckReaction && hasWhatsAppConfig) {
    const hasWhatsAppAck = cfg.channels?.whatsapp?.ackReaction !== undefined;
    if (!hasWhatsAppAck) {
      const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
      let direct = true;
      let group: "always" | "mentions" | "never" = "mentions";
      if (legacyScope === "all") {
        direct = true;
        group = "always";
      } else if (legacyScope === "direct") {
        direct = true;
        group = "never";
      } else if (legacyScope === "group-all") {
        direct = false;
        group = "always";
      } else if (legacyScope === "group-mentions") {
        direct = false;
        group = "mentions";
      }
      next = {
        ...next,
        channels: {
          ...next.channels,
          whatsapp: {
            ...next.channels?.whatsapp,
            ackReaction: { emoji: legacyAckReaction, direct, group },
          },
        },
      };
      changes.push(
        `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
      );
    }
  }

  return { config: next, changes };
}
