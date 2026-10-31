// Cron payload merge rules applied when cron.update patches an existing job.
import type { CronPayload, CronPayloadPatch } from "../types.js";

type CronPayloadToolAllow = Pick<CronPayload, "toolsAllow" | "toolsAllowIsDefault">;
type CronPayloadToolAllowPatch = Pick<CronPayloadPatch, "toolsAllow" | "toolsAllowIsDefault">;

function applyToolsAllowPatch(
  payload: CronPayloadToolAllow,
  patch: CronPayloadToolAllowPatch,
  existing?: CronPayloadToolAllow,
): void {
  if (Array.isArray(patch.toolsAllow)) {
    const toolsAllow = patch.toolsAllow;
    payload.toolsAllow = toolsAllow;
    // Same-kind edits keep the marker whenever the default-stamped list is
    // unchanged — even when the patch omits toolsAllowIsDefault, because the
    // cron tool's model-facing schema never sends it. Dropping the marker on an
    // echoed list silently reclassifies "default" as an explicit restriction,
    // which fail-closes the next run on CLI backends that cannot enforce
    // runtime toolsAllow. Kind replacements (no existing payload) still require
    // the cron-tool-stamped marker on the patch itself.
    const existingDefaultUnchanged =
      existing?.toolsAllowIsDefault === true &&
      Array.isArray(existing.toolsAllow) &&
      existing.toolsAllow.length === toolsAllow.length &&
      existing.toolsAllow.every((toolName, index) => toolName === toolsAllow[index]);
    const installsDefault =
      patch.toolsAllowIsDefault === true && existing?.toolsAllowIsDefault !== true;
    const keepDefaultMarker = existingDefaultUnchanged || installsDefault;
    if (keepDefaultMarker) {
      payload.toolsAllowIsDefault = true;
    } else {
      delete payload.toolsAllowIsDefault;
    }
  } else if (patch.toolsAllow === null) {
    delete payload.toolsAllow;
    delete payload.toolsAllowIsDefault;
  }
}

export function mergeCronPayload(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind !== existing.kind) {
    const next = mergePayloadFields(buildPayloadFromPatch(patch), patch);
    // toolsAllow is shared security state. Kind changes must not silently
    // reopen a restricted trigger runtime; null remains the explicit clear.
    if (patch.toolsAllow === undefined && Array.isArray(existing.toolsAllow)) {
      next.toolsAllow = [...existing.toolsAllow];
      if (existing.toolsAllowIsDefault === true) {
        next.toolsAllowIsDefault = true;
      }
    }
    return next;
  }
  return mergePayloadFields(existing, patch);
}

function mergePayloadFields(existing: CronPayload, patch: CronPayloadPatch): CronPayload {
  const next = { ...existing };
  if (patch.kind === "systemEvent" && next.kind === "systemEvent") {
    if (typeof patch.text === "string") {
      next.text = patch.text;
    }
  } else if (patch.kind === "command" && next.kind === "command") {
    if (Array.isArray(patch.argv)) {
      next.argv = patch.argv;
    }
    if (typeof patch.cwd === "string") {
      next.cwd = patch.cwd;
    }
    if (patch.env && typeof patch.env === "object" && !Array.isArray(patch.env)) {
      next.env = patch.env;
    }
    if (typeof patch.input === "string") {
      next.input = patch.input;
    }
    if (typeof patch.noOutputTimeoutSeconds === "number") {
      next.noOutputTimeoutSeconds = patch.noOutputTimeoutSeconds;
    }
    if (typeof patch.outputMaxBytes === "number") {
      next.outputMaxBytes = patch.outputMaxBytes;
    }
  } else if (patch.kind === "script" && next.kind === "script") {
    if (typeof patch.script === "string") {
      next.script = patch.script;
    }
    if (typeof patch.toolBudget === "number") {
      next.toolBudget = patch.toolBudget;
    }
  } else if (patch.kind === "agentTurn" && next.kind === "agentTurn") {
    if (typeof patch.message === "string") {
      next.message = patch.message;
    }
    for (const field of ["model", "thinking"] as const) {
      if (typeof patch[field] === "string") {
        next[field] = patch[field];
      } else if (patch[field] === null) {
        delete next[field];
      }
    }
    if (Array.isArray(patch.fallbacks)) {
      next.fallbacks = patch.fallbacks;
    } else if (patch.fallbacks === null) {
      delete next.fallbacks;
    }
    if (typeof patch.lightContext === "boolean") {
      next.lightContext = patch.lightContext;
    }
    if (typeof patch.skipIfScratchEmpty === "boolean") {
      next.skipIfScratchEmpty = patch.skipIfScratchEmpty;
    }
    if (typeof patch.includeReasoning === "boolean") {
      next.includeReasoning = patch.includeReasoning;
    }
    if (typeof patch.allowUnsafeExternalContent === "boolean") {
      next.allowUnsafeExternalContent = patch.allowUnsafeExternalContent;
    }
  }

  applyToolsAllowPatch(next, patch, existing);
  if ("timeoutSeconds" in patch && next.kind !== "systemEvent") {
    if (typeof patch.timeoutSeconds === "number") {
      next.timeoutSeconds = patch.timeoutSeconds;
    } else if (patch.timeoutSeconds === null) {
      delete next.timeoutSeconds;
    }
  }
  return next;
}

function buildPayloadFromPatch(patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "systemEvent") {
    if (typeof patch.text !== "string" || patch.text.length === 0) {
      throw new Error('cron.update payload.kind="systemEvent" requires text');
    }
    return { kind: "systemEvent", text: patch.text };
  }

  if (patch.kind === "command") {
    if (!Array.isArray(patch.argv) || patch.argv.length === 0) {
      throw new Error('cron.update payload.kind="command" requires argv');
    }
    return { kind: "command", argv: patch.argv };
  }

  if (patch.kind === "script") {
    if (typeof patch.script !== "string" || patch.script.trim().length === 0) {
      throw new Error('cron.update payload.kind="script" requires script');
    }
    return { kind: "script", script: patch.script };
  }

  if (typeof patch.message !== "string" || patch.message.length === 0) {
    throw new Error('cron.update payload.kind="agentTurn" requires message');
  }

  return { kind: "agentTurn", message: patch.message };
}
