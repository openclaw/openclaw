import { normalizeSafeBinProfileFixtures } from "../infra/exec-safe-bin-policy.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import type { OpenClawConfig } from "./types.js";

export function normalizeExecSafeBinProfilesInConfig(cfg: OpenClawConfig): void {
  const normalizeExec = (exec: unknown) => {
    if (!exec || typeof exec !== "object" || Array.isArray(exec)) {
      return;
    }
    const typedExec = exec as {
      safeBinProfiles?: Record<string, unknown>;
      safeBinTrustedDirs?: string[];
    };
    const normalizedProfiles = normalizeSafeBinProfileFixtures(
      typedExec.safeBinProfiles as Record<
        string,
        {
          minPositional?: number;
          maxPositional?: number;
          allowedValueFlags?: readonly string[];
          deniedFlags?: readonly string[];
        }
      >,
    );
    if (Object.keys(normalizedProfiles).length > 0) {
      typedExec.safeBinProfiles = normalizedProfiles;
    } else {
      delete typedExec.safeBinProfiles;
    }
    const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(typedExec.safeBinTrustedDirs);
    if (normalizedTrustedDirs.length > 0) {
      typedExec.safeBinTrustedDirs = normalizedTrustedDirs;
    } else {
      delete typedExec.safeBinTrustedDirs;
    }
  };

  normalizeExec(cfg.tools?.exec);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    normalizeExec(agent?.tools?.exec);
  }
}
