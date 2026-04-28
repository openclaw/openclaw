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
    typedExec.safeBinProfiles =
      Object.keys(normalizedProfiles).length > 0 ? normalizedProfiles : undefined;
    const normalizedTrustedDirs = normalizeTrustedSafeBinDirs(typedExec.safeBinTrustedDirs);
    typedExec.safeBinTrustedDirs =
      normalizedTrustedDirs.length > 0 ? normalizedTrustedDirs : undefined;
  };

  normalizeExec(cfg.tools?.exec);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    normalizeExec(agent?.tools?.exec);
  }
}
