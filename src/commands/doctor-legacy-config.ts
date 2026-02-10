import type { OpenClawConfig } from "../config/config.js";
export function normalizeLegacyConfigValues(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  let next: OpenClawConfig = cfg;

  const legacyAckReaction = cfg.messages?.ackReaction;
  const legacyAckCandidates =
    legacyAckReaction === undefined
      ? null
      : (Array.isArray(legacyAckReaction) ? legacyAckReaction : [legacyAckReaction])
          .map((item) => item.trim())
          .filter(Boolean);
  const legacyAckReactionValue =
    legacyAckCandidates && legacyAckCandidates.length > 0
      ? legacyAckCandidates.length === 1
        ? legacyAckCandidates[0]
        : legacyAckCandidates
      : null;
  const hasWhatsAppConfig = cfg.channels?.whatsapp !== undefined;
  if (legacyAckReactionValue && hasWhatsAppConfig) {
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
            ackReaction: { emoji: legacyAckReactionValue, direct, group },
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
