const TELEGRAM_DM_GESAHNI_COMMAND_MAP: Record<string, string> = {
  watchlist: "/watchlist",
  quote: "/quote",
  price: "/quote",
  positions: "/positions",
  summary: "/summary",
  status: "/summary",
  alerts: "/alerts",
  earnings: "/earnings",
  portfolio: "/portfolio",
  options: "/options",
  "alert-history": "/alert_history",
  "option-alerts": "/option_alerts",
  "options-status": "/options_status",
  "earnings-coverage": "/earnings_coverage",
  "earnings-reminders": "/earnings_reminders",
  "/option-alerts": "/option_alerts",
  "/options-status": "/options_status",
  "/quote": "/quote",
  "/price": "/quote",
  "/earnings-coverage": "/earnings_coverage",
  "/earnings-reminders": "/earnings_reminders",
  "/alert-history": "/alert_history",
};

function normalizeTickerCandidate(value: string): string | null {
  const normalized = value.trim().replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,14}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeThresholdCandidate(value: string): string | null {
  const parsed = Number(value.trim().replace(/^\$/, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  if (Number.isInteger(parsed)) {
    return String(parsed);
  }
  return parsed.toFixed(2).replace(/\.?0+$/, "");
}

function normalizeUuidCandidate(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function rewriteTelegramDmGesahniWriteIntent(rawBody: string): string | null {
  const text = rawBody.trim();
  if (!text) {
    return null;
  }

  const confirmMatch = text.match(/^confirm(?:\s+([A-Za-z0-9:_-]{1,200}))?$/i);
  if (confirmMatch) {
    const pendingActionId = confirmMatch[1]?.trim();
    return pendingActionId ? `/gesahni_confirm ${pendingActionId}` : "/gesahni_confirm";
  }

  const addMatch = text.match(
    /^(?:add|watch)\s+([A-Za-z][A-Za-z0-9._-]{0,14})\s+(?:to|into|on)\s+(?:my\s+)?watchlist$/i,
  );
  if (addMatch) {
    const symbol = normalizeTickerCandidate(addMatch[1] ?? "");
    if (symbol) {
      return `/watchlist_add ${symbol}`;
    }
  }

  const removeMatch = text.match(
    /^(?:remove|delete)\s+([A-Za-z][A-Za-z0-9._-]{0,14})\s+(?:from|off)\s+(?:my\s+)?watchlist$/i,
  );
  if (removeMatch) {
    const symbol = normalizeTickerCandidate(removeMatch[1] ?? "");
    if (symbol) {
      return `/watchlist_remove ${symbol}`;
    }
  }

  const createOptionAlertMatch = text.match(
    /^(?:create|add)\s+(?:an?\s+)?option(?:\s+alert|\s+watch\s+rule)?\s+(?:for\s+)?([0-9a-f-]{36})\s+(?:when\s+)?(?:premium|price)\s+(?:goes?\s+|is\s+|crosses?\s+)?(above|below)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (createOptionAlertMatch) {
    const contractId = normalizeUuidCandidate(createOptionAlertMatch[1] ?? "");
    const direction = (createOptionAlertMatch[2] ?? "").toLowerCase();
    const threshold = normalizeThresholdCandidate(createOptionAlertMatch[3] ?? "");
    if (contractId && (direction === "above" || direction === "below") && threshold) {
      return `/options_watch_rule_create ${contractId} ${direction} ${threshold}`;
    }
  }

  const updateOptionAlertMatch = text.match(
    /^(?:change|update)\s+(?:my\s+)?option(?:\s+alert|\s+watch\s+rule)?\s+([0-9a-f-]{36})\s+(?:to|at)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (updateOptionAlertMatch) {
    const ruleId = normalizeUuidCandidate(updateOptionAlertMatch[1] ?? "");
    const threshold = normalizeThresholdCandidate(updateOptionAlertMatch[2] ?? "");
    if (ruleId && threshold) {
      return `/options_watch_rule_update ${ruleId} ${threshold}`;
    }
  }

  const deleteOptionAlertMatch = text.match(
    /^(?:delete|remove)\s+(?:my\s+)?option(?:\s+alert|\s+watch\s+rule)?\s+([0-9a-f-]{36})$/i,
  );
  if (deleteOptionAlertMatch) {
    const ruleId = normalizeUuidCandidate(deleteOptionAlertMatch[1] ?? "");
    if (ruleId) {
      return `/options_watch_rule_delete ${ruleId}`;
    }
  }

  const applyOptionSuggestionMatch = text.match(
    /^(?:apply)\s+(?:option\s+)?suggestion\s+([0-9a-f-]{36})$/i,
  );
  if (applyOptionSuggestionMatch) {
    const suggestionId = normalizeUuidCandidate(applyOptionSuggestionMatch[1] ?? "");
    if (suggestionId) {
      return `/options_alert_suggestion_apply ${suggestionId}`;
    }
  }

  if (/^(?:apply)\s+(?:that|this)\s+suggestion$/i.test(text)) {
    return "/options_alert_suggestion_apply";
  }

  if (/^(?:apply)\s+all\s+(?:option\s+)?suggestions$/i.test(text)) {
    return "/options_suggestions_apply_all";
  }

  const crossingMatch = text.match(
    /^(?:alert me if|let me know when|notify me when|tell me when)\s+([A-Za-z][A-Za-z0-9._-]{0,14})\s+(?:goes?|gets?|is|crosses?|moves?)\s+(above|below)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (crossingMatch) {
    const symbol = normalizeTickerCandidate(crossingMatch[1] ?? "");
    const direction = (crossingMatch[2] ?? "").toLowerCase();
    const threshold = normalizeThresholdCandidate(crossingMatch[3] ?? "");
    if (symbol && (direction === "above" || direction === "below") && threshold) {
      return `/alert_create ${symbol} ${direction} ${threshold}`;
    }
  }

  const dropMatch = text.match(
    /^(?:alert me if|let me know when|notify me when|tell me when)\s+([A-Za-z][A-Za-z0-9._-]{0,14})\s+(?:drops?|falls?)\s+below\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (dropMatch) {
    const symbol = normalizeTickerCandidate(dropMatch[1] ?? "");
    const threshold = normalizeThresholdCandidate(dropMatch[2] ?? "");
    if (symbol && threshold) {
      return `/alert_create ${symbol} below ${threshold}`;
    }
  }

  const hitsMatch = text.match(
    /^(?:alert me if|let me know when|notify me when|tell me when)\s+([A-Za-z][A-Za-z0-9._-]{0,14})\s+hits?\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (hitsMatch) {
    const symbol = normalizeTickerCandidate(hitsMatch[1] ?? "");
    const threshold = normalizeThresholdCandidate(hitsMatch[2] ?? "");
    if (symbol && threshold) {
      return `/alert_create ${symbol} above ${threshold}`;
    }
  }

  const updateBySymbolMatch = text.match(
    /^(?:change|update)\s+(?:my\s+)?([A-Za-z][A-Za-z0-9._-]{0,14})\s+alert\s+(?:to|at)\s+\$?([0-9]+(?:\.[0-9]+)?)$/i,
  );
  if (updateBySymbolMatch) {
    const symbol = normalizeTickerCandidate(updateBySymbolMatch[1] ?? "");
    const threshold = normalizeThresholdCandidate(updateBySymbolMatch[2] ?? "");
    if (symbol && threshold) {
      return `/alert_update ${symbol} ${threshold}`;
    }
  }

  const deleteBySymbolMatch = text.match(
    /^(?:delete|remove)\s+(?:my\s+)?([A-Za-z][A-Za-z0-9._-]{0,14})\s+alert$/i,
  );
  if (deleteBySymbolMatch) {
    const symbol = normalizeTickerCandidate(deleteBySymbolMatch[1] ?? "");
    if (symbol) {
      return `/alert_delete ${symbol}`;
    }
  }

  return null;
}

function rewriteTelegramDmGesahniQuoteIntent(rawBody: string): string | null {
  const text = rawBody.trim();
  if (!text) {
    return null;
  }

  const explicitQuoteMatch =
    text.match(
      /^(?:what(?:'s| is)\s+)?(?:the\s+)?price\s+(?:for|of)\s+(\$?[A-Za-z][A-Za-z0-9._-]{0,14})$/i,
    ) ?? text.match(/^how much is\s+(\$?[A-Za-z][A-Za-z0-9._-]{0,14})$/i);
  if (explicitQuoteMatch) {
    const symbol = normalizeTickerCandidate(explicitQuoteMatch[1] ?? "");
    if (symbol) {
      return `/quote ${symbol}`;
    }
  }

  const trailingPriceMatch = text.match(
    /^(?:(?:check|show|get)\s+)?(\$?[A-Za-z][A-Za-z0-9._-]{0,14})\s+price$/i,
  );
  if (trailingPriceMatch) {
    const symbol = normalizeTickerCandidate(trailingPriceMatch[1] ?? "");
    if (symbol) {
      return `/quote ${symbol}`;
    }
  }

  const bareTickerMatch = text.match(/^\$?([A-Z][A-Z0-9._-]{0,4})$/);
  if (bareTickerMatch) {
    const symbol = normalizeTickerCandidate(bareTickerMatch[1] ?? "");
    if (symbol) {
      return `/quote ${symbol}`;
    }
  }

  return null;
}

export function normalizeTelegramDmGesahniCommandBody(params: {
  rawBody: string;
  isGroup: boolean;
}): string {
  if (params.isGroup) {
    return params.rawBody;
  }
  const rewrittenWriteIntent = rewriteTelegramDmGesahniWriteIntent(params.rawBody);
  if (rewrittenWriteIntent) {
    return rewrittenWriteIntent;
  }
  const rewrittenQuoteIntent = rewriteTelegramDmGesahniQuoteIntent(params.rawBody);
  if (rewrittenQuoteIntent) {
    return rewrittenQuoteIntent;
  }
  const trimmedRaw = params.rawBody.trim();
  const [rawHead, ...tailParts] = trimmedRaw.split(/\s+/);
  const head = rawHead?.toLowerCase();
  const mapped = head ? TELEGRAM_DM_GESAHNI_COMMAND_MAP[head] : undefined;
  if (!mapped) {
    return params.rawBody;
  }
  const tail = tailParts.join(" ").trim();
  return tail ? `${mapped} ${tail}` : mapped;
}

export function resolveGesahniUserIdForContext(params: {
  surface?: string;
  provider?: string;
  originatingTo?: string;
  to?: string;
  isGroup?: boolean;
}): string | null {
  if (params.isGroup) {
    return null;
  }
  const channel = String(params.surface || params.provider || "")
    .trim()
    .toLowerCase();
  if (channel !== "telegram") {
    return null;
  }
  const to = String(params.originatingTo || params.to || "").trim();
  const match = to.match(/^telegram:(-?\d+)$/);
  if (!match) {
    return null;
  }
  return `tg:${match[1]}`;
}
