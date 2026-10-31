import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { i18n, t } from "../i18n/index.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";

// Above what three lines hold in any theme, so a long transcript never reaches layout.
const EXCERPT_MAX_GRAPHEMES = 320;

function cutExcerpt(text: string, graphemes: number): string {
  return `${takeGraphemes(text, graphemes).replace(/[\s\p{Po}]+$/u, "")}…`;
}

/**
 * Writes only the part of the source that fits the element's line clamp, as one text node.
 * The first write and the search share a task, so only the final text is painted.
 */
export function writeHovercardExcerpt(element: HTMLElement, source: string): void {
  const text = source.replace(/\s+/gu, " ").trim();
  const fits = () => element.scrollHeight <= element.clientHeight;
  element.textContent =
    takeGraphemes(text, EXCERPT_MAX_GRAPHEMES) === text
      ? text
      : cutExcerpt(text, EXCERPT_MAX_GRAPHEMES);
  if (fits()) {
    return;
  }
  let fitting = 0;
  let overflowing = Math.min(text.length, EXCERPT_MAX_GRAPHEMES);
  while (overflowing - fitting > 1) {
    const middle = Math.floor((fitting + overflowing) / 2);
    element.textContent = cutExcerpt(text, middle);
    if (fits()) {
      fitting = middle;
    } else {
      overflowing = middle;
    }
  }
  element.textContent = cutExcerpt(text, fitting);
}

export function participantLabel(participant: SessionParticipant): string {
  return participant.label?.trim() || participant.identity.id;
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
      if (
        (participant.identity.type === "profile" && participant.identity.id === selfUserId) ||
        id === JSON.stringify(creator?.identity)
      ) {
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
