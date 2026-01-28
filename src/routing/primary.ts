import type { SessionEntry } from "../config/sessions.js";
import type { MoltbotConfig, PrimaryRoutingChannel } from "../config/types.js";
import { applyTemplate, type TemplateContext } from "../auto-reply/templating.js";

export type PrimaryRoutingMode = "primary-only" | "mirror";

export type ResolvedPrimaryRouting = {
  mode: PrimaryRoutingMode;
  channel: PrimaryRoutingChannel;
  to?: string;
  nonPrimaryNote?: string;
};

const PRIMARY_CHANNELS = new Set<PrimaryRoutingChannel>([
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
]);

function normalizeChannel(value?: string): PrimaryRoutingChannel | undefined {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) {
    return undefined;
  }
  if (raw === "imsg") {
    return "imessage";
  }
  if (raw === "tg") {
    return "telegram";
  }
  if (raw === "wa") {
    return "whatsapp";
  }
  if (PRIMARY_CHANNELS.has(raw as PrimaryRoutingChannel)) {
    return raw as PrimaryRoutingChannel;
  }
  return undefined;
}

/**
 * Resolve primary routing config from the Moltbot config.
 */
export function resolvePrimaryRouting(cfg: MoltbotConfig): ResolvedPrimaryRouting | null {
  const primary = cfg.routing?.primary;
  if (!primary) {
    return null;
  }

  const channel = normalizeChannel(primary.channel);
  if (!channel) {
    return null;
  }

  const mode: PrimaryRoutingMode = primary.mode === "mirror" ? "mirror" : "primary-only";
  const to = typeof primary.to === "string" && primary.to.trim() ? primary.to.trim() : undefined;
  const nonPrimaryNote =
    typeof primary.nonPrimaryNote === "string" && primary.nonPrimaryNote.trim()
      ? primary.nonPrimaryNote
      : undefined;

  return { mode, channel, to, nonPrimaryNote };
}

/**
 * Resolve the target address for the primary channel.
 * If routing.to is specified, use that. Otherwise fall back to session's lastTo if it matches.
 */
export function resolvePrimaryTarget(
  routing: ResolvedPrimaryRouting,
  entry?: SessionEntry,
): string | undefined {
  if (routing.to) {
    return routing.to;
  }
  if (entry?.lastChannel === routing.channel && entry.lastTo?.trim()) {
    return entry.lastTo.trim();
  }
  return undefined;
}

/**
 * Check if the given surface is the primary routing surface.
 */
export function isPrimarySurface(
  surface: string | undefined,
  routing: ResolvedPrimaryRouting | null,
): boolean {
  if (!routing) {
    return false;
  }
  const normalized = normalizeChannel(surface);
  return normalized === routing.channel;
}

/**
 * Resolve the non-primary routing note to prepend to replies sent to the primary channel.
 */
export function resolveNonPrimaryRoutingNote(params: {
  cfg: MoltbotConfig;
  ctx: TemplateContext;
}): string | undefined {
  const routing = resolvePrimaryRouting(params.cfg);
  if (!routing?.nonPrimaryNote) {
    return undefined;
  }
  const inbound = normalizeChannel(params.ctx.Surface);
  if (!inbound) {
    return undefined;
  }
  if (isPrimarySurface(params.ctx.Surface, routing)) {
    return undefined;
  }
  const rendered = applyTemplate(routing.nonPrimaryNote, params.ctx);
  if (!rendered.trim()) {
    return undefined;
  }
  return rendered;
}

/**
 * Determine where to deliver replies based on primary routing config.
 */
export function resolvePrimaryDeliveryDecision(params: {
  cfg: MoltbotConfig;
  inboundSurface?: string;
  entry?: SessionEntry;
}): {
  sendToSource: boolean;
  sendToPrimary: boolean;
  primaryChannel?: PrimaryRoutingChannel;
  primaryTo?: string;
} {
  const routing = resolvePrimaryRouting(params.cfg);
  if (!routing) {
    return { sendToSource: true, sendToPrimary: false };
  }

  if (isPrimarySurface(params.inboundSurface, routing)) {
    return {
      sendToSource: true,
      sendToPrimary: false,
      primaryChannel: routing.channel,
    };
  }

  const primaryTo = resolvePrimaryTarget(routing, params.entry);
  if (!primaryTo) {
    return {
      sendToSource: true,
      sendToPrimary: false,
      primaryChannel: routing.channel,
    };
  }

  return {
    sendToSource: routing.mode === "mirror",
    sendToPrimary: true,
    primaryChannel: routing.channel,
    primaryTo,
  };
}
