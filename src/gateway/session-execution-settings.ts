import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";

/** Projects validated execution preferences; admission and commit guards remain with the patch owner. */
export function applySessionExecutionSettings(
  next: SessionEntry,
  patch: SessionsPatchParams,
): string | undefined {
  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecTarget(raw) ?? undefined;
      if (!normalized) {
        return 'invalid execHost (use "auto"|"sandbox"|"gateway"|"node")';
      }
      next.execHost = normalized;
    }
  }

  if ("execNode" in patch) {
    if (patch.execNode === null) {
      delete next.execNode;
      delete next.execCwd;
      if (next.execHost === "node") {
        delete next.execHost;
      }
    } else if (patch.execNode !== undefined) {
      const trimmed = normalizeOptionalString(patch.execNode) ?? "";
      if (!trimmed) {
        return "invalid execNode: empty";
      }
      if (trimmed !== next.execNode) {
        // A cwd belongs to one node's filesystem; never carry it across node bindings.
        delete next.execCwd;
      }
      next.execNode = trimmed;
    }
  }
  if (patch.sandboxMode === "off") {
    if (next.sandbox === "required") {
      return "This session requires a sandbox and cannot run without one.";
    }
    next.sandboxMode = "off";
  } else if (patch.sandboxMode === null) {
    delete next.sandboxMode;
  }
  if (patch.permissionMode === null) {
    delete next.permissionMode;
  } else if (patch.permissionMode !== undefined) {
    next.permissionMode = patch.permissionMode;
  }
  if (
    patch.nativeRuntimeConsent === null ||
    next.permissionMode !== "full" ||
    next.sandboxMode !== "off"
  ) {
    delete next.nativeRuntimeConsent;
  } else if (patch.nativeRuntimeConsent !== undefined) {
    next.nativeRuntimeConsent = patch.nativeRuntimeConsent;
  }
  return undefined;
}
