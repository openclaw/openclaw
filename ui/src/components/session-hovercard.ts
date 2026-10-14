import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { i18n, t } from "../i18n/index.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import type { SessionCreatedActor } from "./session-owner-chip.ts";

export function participantLabel(participant: SessionParticipant): string {
  return participant.label?.trim() || participant.identity.id;
}

function excludesParticipant(
  participant: SessionParticipant,
  creator: SessionCreatedActor | undefined,
  selfUserId: string | undefined,
): boolean {
  return (
    (participant.identity.type === "profile" && participant.identity.id === selfUserId) ||
    JSON.stringify(participant.identity) === JSON.stringify(creator?.identity)
  );
}

type SessionAgeUnit = RelativeTimeUnit | "week" | "month" | "year";

function sessionAgeBucket(diffMs: number): { value: number; unit: SessionAgeUnit } {
  const days = Math.abs(diffMs) / (24 * 60 * 60_000);
  if (days >= 365) {
    return { value: Math.round(days / 365), unit: "year" };
  }
  if (days >= 28) {
    return { value: Math.round(days / 30), unit: "month" };
  }
  if (days >= 7) {
    return { value: Math.round(days / 7), unit: "week" };
  }
  if (days >= 1) {
    return { value: Math.round(days), unit: "day" };
  }
  return bucketRelativeTimeMs(Math.abs(diffMs));
}

export function formatSessionAge(timestamp: number | null | undefined, suffix: boolean): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  const diff = timestamp - Date.now();
  const { value, unit } = sessionAgeBucket(diff);
  if (suffix) {
    if (unit === "second" && diff <= 0) {
      return t("common.justNow");
    }
    return new Intl.RelativeTimeFormat(i18n.getLocale(), {
      numeric: "always",
      style: "narrow",
    }).format(diff <= 0 ? -value : value, unit);
  }
  if (i18n.getLocale().toLowerCase().startsWith("en")) {
    const compactSuffix: Record<SessionAgeUnit, string> = {
      second: "s",
      minute: "m",
      hour: "h",
      day: "d",
      week: "w",
      month: "mo",
      year: "y",
    };
    return `${value}${compactSuffix[unit]}`;
  }
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(value);
}

export function sessionAttribution(
  row: SidebarSessionHovercardRow,
  selfUserId: string | undefined,
) {
  const creator = row.createdActor;
  const creatorLabel = creator?.label?.trim() || creator?.id?.trim();
  const participantIds = new Set<string>();
  let excludedProjectedCount = 0;
  const participants = (row.expandedParticipants ?? row.participants ?? []).filter(
    (participant) => {
      const id = JSON.stringify(participant.identity);
      if (participantIds.has(id)) {
        return false;
      }
      participantIds.add(id);
      if (excludesParticipant(participant, creator, selfUserId)) {
        excludedProjectedCount += 1;
        return false;
      }
      return true;
    },
  );
  const participantCount = Math.max(
    participants.length,
    (row.participantCount ?? 0) - excludedProjectedCount,
  );
  if (creator && creatorLabel) {
    return {
      creator,
      primaryIdentity: creator.identity,
      primaryLabel: creatorLabel,
      participants,
      otherCount: participantCount,
    };
  }
  const primary = participants[0];
  if (!primary) {
    return undefined;
  }
  return {
    primaryIdentity: primary.identity,
    primaryLabel: participantLabel(primary),
    participants,
    otherCount: Math.max(0, participantCount - 1),
  };
}
