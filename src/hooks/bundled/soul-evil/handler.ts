import type { ClawdbotConfig } from "../../../config/config.js";
import { isSubagentSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { AgentBootstrapHookContext, HookHandler } from "../../hooks.js";
import { applySoulEvilOverride, type SoulEvilConfig } from "../../soul-evil.js";

const HOOK_KEY = "soul-evil";

function resolveSoulEvilConfig(entry: Record<string, unknown> | undefined): SoulEvilConfig | null {
  if (!entry) return null;
  const file = typeof entry.file === "string" ? entry.file : undefined;
  const chance = typeof entry.chance === "number" ? entry.chance : undefined;
  const purge =
    entry.purge && typeof entry.purge === "object"
      ? {
          at:
            typeof (entry.purge as { at?: unknown }).at === "string"
              ? (entry.purge as { at?: string }).at
              : undefined,
          duration:
            typeof (entry.purge as { duration?: unknown }).duration === "string"
              ? (entry.purge as { duration?: string }).duration
              : undefined,
        }
      : undefined;
  if (!file && chance === undefined && !purge) return null;
  return { file, chance, purge };
}

const soulEvilHook: HookHandler = async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const context = event.context as AgentBootstrapHookContext;
  if (context.sessionKey && isSubagentSessionKey(context.sessionKey)) return;
  const cfg = context.cfg as ClawdbotConfig | undefined;
  const hookConfig = resolveHookConfig(cfg, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) return;

  const soulConfig = resolveSoulEvilConfig(hookConfig as Record<string, unknown>);
  if (!soulConfig) return;

  const workspaceDir = context.workspaceDir;
  if (!workspaceDir || !Array.isArray(context.bootstrapFiles)) return;

  const updated = await applySoulEvilOverride({
    files: context.bootstrapFiles,
    workspaceDir,
    config: soulConfig,
    userTimezone: cfg?.agents?.defaults?.userTimezone,
    log: {
      warn: (message) => console.warn(`[soul-evil] ${message}`),
      debug: (message) => console.debug?.(`[soul-evil] ${message}`),
    },
  });

  context.bootstrapFiles = updated;
};

export default soulEvilHook;
