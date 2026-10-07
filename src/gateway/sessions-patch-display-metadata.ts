import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
  SESSION_COLOR_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../packages/gateway-protocol/src/session-agent-status.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { parseSessionLabel, SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";

/** Applies display-metadata patch fields onto the next entry; returns an error message on invalid input. */
export function applySessionsPatchDisplayMetadata(params: {
  patch: SessionsPatchParams;
  next: InternalSessionEntry;
  isLabelInUse: (label: string) => boolean;
}): string | undefined {
  const { patch, next } = params;

  for (const field of ["autoLabel", "label"] as const) {
    const raw = patch[field];
    if (raw === null) {
      delete next[field];
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return parsed.error;
      }
      // Device names are presentation metadata, not unique custom-label claims.
      if (field === "label" && params.isLabelInUse(parsed.label)) {
        return `label already in use: ${parsed.label}`;
      }
      next[field] = parsed.label;
    }
  }

  if (patch.icon === null || patch.icon === "") {
    delete next.icon;
  } else if (patch.icon !== undefined) {
    const icon = normalizeSessionIconValue(patch.icon);
    if (!icon) {
      return `icon must be a single emoji, a named icon (${SESSION_ICON_GLYPH_IDS.join(", ")}), or self-contained SVG markup/data URL up to 16 KiB`;
    }
    next.icon = icon;
  }

  if (patch.color === null || patch.color === "") {
    delete next.color;
  } else if (patch.color !== undefined) {
    const color = normalizeSessionColorValue(patch.color);
    if (!color) {
      return `color must be one of: ${SESSION_COLOR_IDS.join(", ")}`;
    }
    next.color = color;
  }

  if (patch.category === null) {
    delete next.category;
  } else if (patch.category !== undefined) {
    // Categories are shared organization buckets, so duplicates are expected (unlike labels).
    const trimmed = normalizeOptionalString(patch.category) ?? "";
    if (!trimmed) {
      return "invalid category: empty";
    }
    if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
      return `invalid category: too long (max ${SESSION_LABEL_MAX_LENGTH})`;
    }
    next.category = trimmed;
  }

  if (patch.boardFace !== undefined) {
    next.boardFace = patch.boardFace;
  }

  if (patch.boardPresentation === null) {
    delete next.boardPresentation;
  } else if (patch.boardPresentation !== undefined) {
    next.boardPresentation = patch.boardPresentation;
  }

  return undefined;
}
