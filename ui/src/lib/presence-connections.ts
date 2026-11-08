import type { PresenceEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { gatewayClientKind } from "./gateway-client-kind.ts";
import { describePlatform } from "./platform-label.ts";

function presenceConnectionDescription(entry: PresenceEntry): string {
  const family = entry.deviceFamily?.trim();
  const platform = describePlatform(entry.platform ?? "", family);
  const familyPlatform = family === "Mac" ? "macOS" : family === "iPad" ? "iPadOS" : family;
  const kind = gatewayClientKind({ id: entry.clientId, mode: entry.mode });
  const app = kind ? t(`presence.card.${kind}`) : undefined;
  return [
    ...new Set(
      [
        family,
        platform.label === familyPlatform ? undefined : platform.label,
        platform.architecture,
        app,
      ]
        .map((value) => value?.trim())
        .filter(Boolean),
    ),
  ].join(" · ");
}

export function presenceConnectionDescriptions(entries: readonly PresenceEntry[]): string[] {
  // Matching reported facts describe connections, never a count of physical devices.
  return [...new Set(entries.map(presenceConnectionDescription).filter(Boolean))].toSorted();
}

export function groupPresenceConnections(entries: readonly PresenceEntry[]) {
  const groups = new Map<string, { description: string; entry: PresenceEntry; count: number }>();
  for (const entry of entries) {
    const description = presenceConnectionDescription(entry);
    // Retain distinct network/host facts in diagnostics even when the compact description matches.
    const key = JSON.stringify([description, entry.host, entry.platform, entry.ip, entry.timeZone]);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (
        entry.lastInputSeconds !== undefined &&
        (group.entry.lastInputSeconds === undefined ||
          entry.lastInputSeconds < group.entry.lastInputSeconds)
      ) {
        group.entry = entry;
      }
    } else {
      groups.set(key, { description, entry, count: 1 });
    }
  }
  return [...groups.values()];
}
