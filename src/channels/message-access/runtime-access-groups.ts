import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import type { ChannelIngressAdapter, ResolveChannelMessageIngressParams } from "./runtime-types.js";
import type { AccessGroupMembershipFact, ChannelIngressChannelId } from "./types.js";

function accessGroupNames(entries: readonly (string | number)[]): string[] {
  return uniqueStrings(
    entries
      .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
      .filter((entry): entry is string => entry != null),
  );
}

/** Extracts every referenced access-group name from raw allowlist entry groups. */
export function allReferencedAccessGroupNames(
  entries: Array<readonly (string | number)[]>,
): string[] {
  return uniqueStrings(entries.flatMap((entryGroup) => accessGroupNames(entryGroup)));
}

/** Normalizes direct entries while preserving access-group tokens for later expansion. */
export async function normalizeEffectiveEntries(params: {
  /** Channel adapter used only for direct entries; access-group tokens remain literal. */
  adapter: ChannelIngressAdapter;
  /** Account scope passed to adapter normalization. */
  accountId: string;
  /** Raw allowlist entries before adapter normalization. */
  entries: readonly (string | number)[];
  /** Ingress phase whose normalization rules apply to direct entries. */
  context: "dm" | "group" | "route" | "command";
}): Promise<string[]> {
  const rawEntries = normalizeStringEntries(params.entries);
  const accessGroupEntries = rawEntries.filter(
    (entry) => parseAccessGroupAllowFromEntry(entry) != null,
  );
  const directEntries = rawEntries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
  if (directEntries.length === 0) {
    return accessGroupEntries;
  }
  const normalized = await params.adapter.normalizeEntries({
    entries: directEntries,
    context: params.context,
    accountId: params.accountId,
  });
  return uniqueStrings([
    ...accessGroupEntries,
    ...normalized.matchable.map((entry) => entry.value),
  ]);
}

/** Resolves dynamic access-group facts before the state builder expands static sender groups. */
export async function resolveRuntimeAccessGroupMembershipFacts(params: {
  /** Full ingress input so dynamic resolvers see the same subject/config as state resolution. */
  input: ResolveChannelMessageIngressParams;
  /** Normalized channel id passed to dynamic access-group resolvers. */
  channelId: ChannelIngressChannelId;
  /** Referenced group names gathered from every allowlist surface before state building. */
  names: readonly string[];
}): Promise<AccessGroupMembershipFact[]> {
  if (!params.input.resolveAccessGroupMembership || params.names.length === 0) {
    return [];
  }
  const facts: AccessGroupMembershipFact[] = [];
  for (const name of params.names) {
    const group = params.input.accessGroups?.[name];
    if (!group || group.type === "message.senders") {
      continue;
    }
    try {
      const matched = await params.input.resolveAccessGroupMembership({
        name,
        group,
        channelId: params.channelId,
        accountId: params.input.accountId,
        subject: params.input.subject,
      });
      facts.push(
        matched
          ? {
              kind: "matched",
              groupName: name,
              source: "dynamic",
              matchedEntryIds: [`access-group:${name}`],
            }
          : {
              kind: "not-matched",
              groupName: name,
              source: "dynamic",
            },
      );
    } catch {
      // Resolver failures are recorded as facts instead of thrown so one flaky
      // dynamic group fails closed without bypassing the rest of ingress state.
      facts.push({
        kind: "failed",
        groupName: name,
        source: "dynamic",
        reasonCode: "access_group_failed",
        diagnosticId: `access-group:${name}`,
      });
    }
  }
  return facts;
}
