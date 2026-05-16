import type { OpenClawConfig } from "../../config/types.openclaw.js";

export async function finalizeDoctorConfigFlow(params: {
  cfg: OpenClawConfig;
  candidate: OpenClawConfig;
  pendingChanges: boolean;
  shouldRepair: boolean;
  dryRun?: boolean;
  fixHints: string[];
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  note: (message: string, title?: string) => void;
}): Promise<{ cfg: OpenClawConfig; shouldWriteConfig: boolean }> {
  if (params.dryRun && params.pendingChanges) {
    const changes: string[] = [];
    const flatCfg = flattenObject(params.cfg);
    const flatCandidate = flattenObject(params.candidate);
    const allKeys = new Set([...Object.keys(flatCfg), ...Object.keys(flatCandidate)]);
    for (const key of [...allKeys].toSorted()) {
      const oldVal = flatCfg[key];
      const newVal = flatCandidate[key];
      if (oldVal === newVal) {
        continue;
      }
      if (oldVal === undefined) {
        changes.push(`+ ${key}: ${JSON.stringify(newVal)}`);
      } else if (newVal === undefined) {
        changes.push(`- ${key}: ${JSON.stringify(oldVal)}`);
      } else {
        changes.push(`~ ${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
      }
    }
    if (changes.length > 0) {
      params.note(changes.join("\n"), "Dry run — proposed changes (not applied)");
    } else {
      params.note("No config changes detected.", "Dry run");
    }
    return { cfg: params.cfg, shouldWriteConfig: false };
  }

  if (!params.shouldRepair && params.pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      return {
        cfg: params.candidate,
        shouldWriteConfig: true,
      };
    }
    if (params.fixHints.length > 0) {
      params.note(params.fixHints.join("\n"), "Doctor");
    }
    return {
      cfg: params.cfg,
      shouldWriteConfig: false,
    };
  }

  if (params.shouldRepair && params.pendingChanges) {
    return {
      cfg: params.cfg,
      shouldWriteConfig: true,
    };
  }

  return {
    cfg: params.cfg,
    shouldWriteConfig: false,
  };
}

/**
 * Flatten a nested object into dot-separated key paths for diff comparison.
 * Arrays are serialized as leaf values rather than expanded by index.
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, path));
    } else {
      result[path] = JSON.stringify(value);
    }
  }
  return result;
}
