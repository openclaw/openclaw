import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildGroupDisplayName } from "../config/sessions/group-display.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import {
  normalizeSessionSearchLiteral,
  normalizeSessionSearchText,
  rankSessionSearchFields,
} from "../shared/session-search-text.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import type { SessionEntryPair } from "./session-list-order.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";

/** The matcher and its conservative vocabulary must use the same model fields. */
export function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string },
) {
  const provider = normalizeOptionalString(identity.provider);
  const model = normalizeOptionalString(identity.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}

// Search follows the committed entry and physical key; weak keys release retired revisions.
const staticSearchFields = new WeakMap<
  SessionEntry,
  { key: string; literal: string[]; titles: string[] }
>();

export function sessionListSearchFields(key: string, entry: SessionEntry, now: number) {
  let fields = staticSearchFields.get(entry);
  if (!fields || fields.key !== key) {
    const titles = [
      entry.label,
      entry.subject,
      entry.category,
      resolveSessionListSearchDisplayName(key, entry),
      resolveGatewaySessionDisplayName(key, entry),
    ];
    const rawFields = [key, entry.sessionId, ...titles, resolveGatewaySessionKind(key, entry)];
    addSessionListSearchModelFields(rawFields, {
      provider: entry.modelProvider,
      model: entry.model,
    });
    // Goal search uses entry usage, not elapsed time or display-only timestamps.
    const goal = entry.goal && resolveGatewaySessionGoal(entry, now);
    if (goal) {
      rawFields.push(
        `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`,
      );
    }
    fields = {
      key,
      // Both matchers run only for nonempty queries; empty fields can never match.
      literal: rawFields.map(normalizeSessionSearchLiteral).filter(Boolean),
      titles: titles.map(normalizeSessionSearchText).filter(Boolean),
    };
    staticSearchFields.set(entry, fields);
  }
  return fields;
}

/** Rank authorized matches before any partition or global page is truncated. */
export function createSessionSearchComparator(query: string, now: number) {
  const search = normalizeSessionSearchLiteral(query);
  const titleSearch = normalizeSessionSearchText(query);
  const ranks = new Map<string, number>();
  const rank = ([key, entry]: SessionEntryPair) => {
    let value = ranks.get(key);
    if (value === undefined) {
      const fields = sessionListSearchFields(key, entry, now);
      value = Math.max(
        1,
        rankSessionSearchFields(fields.literal, fields.titles, search, titleSearch),
      );
      ranks.set(key, value);
    }
    return value;
  };
  return (a: SessionEntryPair, b: SessionEntryPair) =>
    rank(b) - rank(a) ||
    Number(a[1].archivedAt !== undefined) - Number(b[1].archivedAt !== undefined) ||
    (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0) ||
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
