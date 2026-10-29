import { intersectSessionPermissionModes } from "../../agents/session-permission-exec-mode.js";
import { intersectSessionToolOverrides } from "../../config/sessions/session-tool-overrides.js";
import type { SessionEventTarget } from "./session-event-contract.js";

/** A delayed producer can retain restrictions, never replace current session authority. */
export function narrowSessionEventSettings(
  retained: SessionEventTarget["settings"],
  current: SessionEventTarget["settings"],
): NonNullable<SessionEventTarget["settings"]> {
  return {
    permissionMode: intersectSessionPermissionModes(
      retained?.permissionMode,
      current?.permissionMode,
    ),
    toolOverrides: intersectSessionToolOverrides(retained?.toolOverrides, current?.toolOverrides),
  };
}
