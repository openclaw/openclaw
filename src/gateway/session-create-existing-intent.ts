import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionVisibility } from "./session-sharing.js";

export function resolveExistingSessionCreateIntentError(params: {
  existingEntry: SessionEntry | undefined;
  hasTrustedInitialState: boolean;
  requiresSandbox: boolean;
  hasCatalogTarget: boolean;
  hasWorkspacePreparation: boolean;
  hasSpawnToolPolicy: boolean;
  visibility?: SessionEntry["visibility"];
}): string | undefined {
  const { existingEntry } = params;
  if (!existingEntry) {
    return undefined;
  }
  if (params.hasTrustedInitialState) {
    return "trusted initial session state requires a new session";
  }
  if (params.requiresSandbox && existingEntry.sandbox !== "required") {
    return "sessions.create sandbox requires a new session";
  }
  if (params.hasCatalogTarget) {
    return "catalog session target requires a new session";
  }
  if (params.hasWorkspacePreparation) {
    return "workspace preparation requires a new session";
  }
  if (params.hasSpawnToolPolicy) {
    return "spawn tool policy requires a new session";
  }
  if (params.visibility && resolveSessionVisibility(existingEntry) !== params.visibility) {
    return "sessions.create visibility requires a new session";
  }
  return undefined;
}
