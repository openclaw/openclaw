type DoctorAccountRecord = Record<string, unknown>;

function hasAllowFromEntries(list?: Array<string | number>) {
  return Array.isArray(list) && list.map((v) => String(v).trim()).filter(Boolean).length > 0;
}

function hasConfiguredGroups(account: DoctorAccountRecord, parent?: DoctorAccountRecord): boolean {
  const groups =
    (account.groups as Record<string, unknown> | undefined) ??
    (parent?.groups as Record<string, unknown> | undefined);
  return Boolean(groups) && Object.keys(groups ?? {}).length > 0;
}

type CollectTelegramGroupPolicyWarningsParams = {
  account: DoctorAccountRecord;
  prefix: string;
  effectiveAllowFrom?: Array<string | number>;
  dmPolicy?: string;
  parent?: DoctorAccountRecord;
};

export function collectTelegramGroupPolicyWarnings(
  params: CollectTelegramGroupPolicyWarningsParams,
): string[] {
  if (!hasConfiguredGroups(params.account, params.parent)) {
    const effectiveDmPolicy = params.dmPolicy ?? "pairing";
    const dmSetupLine =
      effectiveDmPolicy === "pairing"
        ? "DMs use pairing mode, so new senders must start a chat and be approved before regular messages are accepted."
        : effectiveDmPolicy === "allowlist"
          ? `DMs use allowlist mode, so only sender IDs in ${params.prefix}.allowFrom are accepted.`
          : effectiveDmPolicy === "open"
            ? "DMs are open."
            : "DMs are disabled.";
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. ${dmSetupLine} Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as Array<string | number> | undefined) ??
    (params.parent?.groupAllowFrom as Array<string | number> | undefined);
  // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
  // unset and falls back to allowFrom.
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const effectiveGroupAllowFrom = groupAllowFrom ?? params.effectiveAllowFrom;

  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return [];
  }

  return [
    `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set ${params.prefix}.groupPolicy to "open".`,
  ];
}
