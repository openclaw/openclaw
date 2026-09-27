import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { DiagnosticEventPrivateData } from "./diagnostic-content-types.js";

type DiagnosticContentEvent = {
  type: string;
  sessionKey?: string;
  deniedReason?: string;
  detector?: string;
  action?: string;
};

function isPrivateEvent(event: DiagnosticContentEvent): boolean {
  return "sessionKey" in event && isIncognitoSessionKey(event.sessionKey);
}

/** Drop optional content before cloning, liveness delivery, or queue admission. */
export function projectDiagnosticEventContent<T extends DiagnosticContentEvent>(event: T): T {
  if (!isPrivateEvent(event)) {
    return event;
  }
  // SAFETY: Every own payload field is copied below except optional content; required status fields remain.
  const projected = {} as T & Record<string, unknown>;
  // SAFETY: Diagnostic inputs are payload objects; keys below come only from this object.
  const fields = event as Record<string, unknown>;
  for (const key of Object.keys(event)) {
    if (
      ((event.type === "message.processed" || event.type === "message.dispatch.completed") &&
        (key === "error" || key === "reason")) ||
      (event.type === "session.state" && key === "reason")
    ) {
      continue;
    }
    Object.defineProperty(projected, key, {
      value:
        event.type === "tool.execution.blocked" && key === "reason"
          ? event.deniedReason
          : event.type === "tool.loop" && key === "message"
            ? `${event.detector}:${event.action}`
            : fields[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return projected;
}

/** Skill accounting remains functional; optional model/tool/error capture does not. */
export function admitDiagnosticPrivateData(
  event: DiagnosticContentEvent,
  privateData: DiagnosticEventPrivateData | undefined,
): DiagnosticEventPrivateData | undefined {
  if (!privateData) {
    return undefined;
  }
  if (isPrivateEvent(event)) {
    return privateData.skillUsage ? { skillUsage: privateData.skillUsage } : undefined;
  }
  if (!Object.hasOwn(privateData, "hostPluginId")) {
    return privateData;
  }
  // Only host object-identity provenance may assign plugin attribution.
  // SAFETY: The copy preserves typed payload fields while permitting removal of undeclared attribution.
  const sanitized = { ...privateData } as Record<string, unknown>;
  delete sanitized.hostPluginId;
  return sanitized;
}
