import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectSessionActor } from "../../gateway/session-identity-projection.js";

/** Resolve stored owner identity through current presentation without losing the agent fallback. */
export function resolveVisibleSessionOwner(
  entry: Pick<SessionEntry, "createdActor" | "owner"> | undefined,
  requesterAgentId: string,
  requesterLabel: string | undefined,
  cfg: OpenClawConfig,
) {
  const actor = entry?.owner?.actor ?? entry?.createdActor;
  if (!actor?.id) {
    return {
      type: "agent" as const,
      id: requesterAgentId,
      ...(requesterLabel ? { label: requesterLabel } : {}),
    };
  }
  const projectedLabel = normalizeOptionalString(projectSessionActor(actor, new Map(), cfg)?.label);
  const storedLabel = normalizeOptionalString(actor.label);
  const fallbackLabel =
    actor.type === "agent" && actor.id === requesterAgentId
      ? normalizeOptionalString(requesterLabel)
      : undefined;
  const label = projectedLabel ?? storedLabel ?? fallbackLabel;
  return {
    type: actor.type,
    id: actor.id,
    ...(label ? { label } : {}),
  };
}
