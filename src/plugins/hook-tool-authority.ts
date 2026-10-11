import { createHash } from "node:crypto";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { PluginHookToolAuthority } from "./hook-types.js";

/** Builds the turn-bound tool authority for policy-bound prompt hooks; `close()` revokes it. */
export function createPromptToolAuthority(params: {
  sourceFingerprint: string;
  activeToolNames: readonly string[];
  assertHostActive: () => void;
}): { authority: PluginHookToolAuthority; assertActive: () => void; close: () => void } {
  const activeToolNames = Object.freeze(
    [...new Set(params.activeToolNames.map(normalizeToolPolicyName).filter(Boolean))].toSorted(),
  );
  const activeToolNameSet = new Set(activeToolNames);
  const token = { active: true };
  const assertActive = () => {
    if (!token.active) {
      throw new Error("prompt tool authority is no longer active");
    }
    params.assertHostActive();
  };
  const authority: PluginHookToolAuthority = Object.freeze({
    fingerprint: createHash("sha256")
      .update(params.sourceFingerprint)
      .update("\0")
      .update(activeToolNames.join("\0"))
      .digest("hex"),
    allows(toolName: string): boolean {
      assertActive();
      return activeToolNameSet.has(normalizeToolPolicyName(toolName));
    },
    list(): readonly string[] {
      assertActive();
      return activeToolNames;
    },
    assertActive,
  });
  return {
    authority,
    assertActive,
    close: () => {
      token.active = false;
    },
  };
}
