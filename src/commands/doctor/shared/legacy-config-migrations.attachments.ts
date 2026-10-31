import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

/** Preserve the shipped document cap before mediaMaxMb becomes media-specific. */
export const ATTACHMENT_LIMITS_MIGRATION: LegacyConfigMigrationSpec = {
  id: "attachments.separate-media-limit",
  legacyRules: [
    {
      path: ["agents", "defaults", "mediaMaxMb"],
      match: (value, root) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        (root.attachments === undefined ||
          (isRecord(root.attachments) && root.attachments.maxFileMb === undefined)),
      message:
        'The inherited chat attachment cap must be preserved in attachments.maxFileMb; run "openclaw doctor --fix" before upgrading.',
    },
  ],
  apply: (raw, changes) => {
    const agents = isRecord(raw.agents) ? raw.agents : undefined;
    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
    const mb = defaults?.mediaMaxMb;
    if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) {
      return;
    }
    if (raw.attachments !== undefined && !isRecord(raw.attachments)) {
      return;
    }
    const attachments = raw.attachments ?? {};
    if (attachments.maxFileMb !== undefined) {
      return;
    }
    // Match the old resolver's whole-byte clamp, including sub-byte/huge values.
    const bytes = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
    attachments.maxFileMb = bytes / (1024 * 1024);
    raw.attachments = attachments;
    changes.push(
      "Preserved the inherited chat attachment limit in attachments.maxFileMb; agents.defaults.mediaMaxMb remains the media budget.",
    );
  },
};
