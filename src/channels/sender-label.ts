import { normalizeOptionalString } from "../shared/string-coerce.js";

export type SenderLabelParams = {
  name?: string;
  username?: string;
  tag?: string;
  e164?: string;
  id?: string;
};

// Gateway internal client IDs that should not be exposed as sender labels.
// These represent the client/UI used, not the actual user identity.
const GATEWAY_INTERNAL_CLIENT_IDS = new Set(["webchat-ui", "openclaw-control-ui", "openclaw-tui"]);

function normalizeSenderLabelParams(params: SenderLabelParams) {
  return {
    name: normalizeOptionalString(params.name),
    username: normalizeOptionalString(params.username),
    tag: normalizeOptionalString(params.tag),
    e164: normalizeOptionalString(params.e164),
    id: normalizeOptionalString(params.id),
  };
}

export function resolveSenderLabel(params: SenderLabelParams): string | null {
  const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);

  const display = name ?? username ?? tag ?? "";
  const idPart = e164 ?? id ?? "";

  // Don't expose raw gateway internal client IDs as labels when no display name is available.
  // These IDs (e.g. "openclaw-control-ui", "webchat-ui", "openclaw-tui") are implementation
  // details and should not be shown to users in the untrusted metadata.
  if (idPart && GATEWAY_INTERNAL_CLIENT_IDS.has(idPart) && !display) {
    return null;
  }

  if (display && idPart && display !== idPart) {
    return `${display} (${idPart})`;
  }
  return display || idPart || null;
}

export function listSenderLabelCandidates(params: SenderLabelParams): string[] {
  const candidates = new Set<string>();
  const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);

  if (name) {
    candidates.add(name);
  }
  if (username) {
    candidates.add(username);
  }
  if (tag) {
    candidates.add(tag);
  }
  if (e164) {
    candidates.add(e164);
  }
  if (id) {
    candidates.add(id);
  }
  const resolved = resolveSenderLabel(params);
  if (resolved) {
    candidates.add(resolved);
  }
  return Array.from(candidates);
}
