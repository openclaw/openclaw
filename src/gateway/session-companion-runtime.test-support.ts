import fs from "node:fs/promises";
import "../test-utils/prepare-compiled-subprocesses.js";
import { vi } from "vitest";
import * as internalSessions from "../agents/internal-session-effects.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { AgentRunSessionTarget } from "../agents/run-session-target.types.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";

/** Augments a fixture's existing stores and workspace; never installs a second state root. */
export function companionRuntimeConfig(cfg: OpenClawConfig, workspaceDir: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        workspace: workspaceDir,
        model: cfg.agents?.defaults?.model ?? "companion-fixture/main",
        utilityModel: "companion-fixture/utility",
      },
    },
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        "companion-fixture": {
          api: "openai-completions",
          apiKey: "synthetic-companion-key",
          baseUrl: "http://127.0.0.1:9/v1",
          models: ["main", "utility"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    },
  };
}

export async function publishCompanionRuntime(
  cfg: OpenClawConfig,
  configPath: string | undefined,
): Promise<void> {
  if (!configPath) {
    throw new Error("Companion fixture requires an isolated config path");
  }
  await fs.writeFile(configPath, JSON.stringify(cfg));
  setRuntimeConfigSnapshot(cfg);
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}

export async function readCompanionSeed(target: AgentRunSessionTarget | undefined) {
  const { agentId, sessionId, sessionKey, storePath } = target ?? {};
  if (!agentId || !sessionId || !sessionKey || !storePath) {
    throw new Error("Expected a complete native internal companion session target");
  }
  return (
    await SessionManager.openAsync({ agentId, sessionId, sessionKey, storePath })
  ).buildSessionContext().messages;
}

/** Join real cleanup even when the caller's cancellation promise settled earlier. */
export function observeCompanionCleanup() {
  const closed = new Map<string, Deferred>();
  const prepare = internalSessions.prepareInternalSessionEffectsSession;
  const remove = internalSessions.removeInternalSessionEffectsSession;
  const preparing = new Set<Promise<unknown>>();
  vi.spyOn(internalSessions, "prepareInternalSessionEffectsSession").mockImplementation(
    (...args) => {
      const work = prepare(...args).then((target) => {
        closed.set(target.sessionKey, createDeferredCore());
        return target;
      });
      preparing.add(work);
      void work.finally(() => preparing.delete(work)).catch(() => {});
      return work;
    },
  );
  vi.spyOn(internalSessions, "removeInternalSessionEffectsSession").mockImplementation(
    async (...args) => {
      try {
        return await remove(...args);
      } finally {
        const sessionKey = args[0]?.sessionKey;
        if (sessionKey) {
          closed.get(sessionKey)?.resolve();
        }
      }
    },
  );
  return async () => {
    await Promise.allSettled(preparing);
    await Promise.all([...closed.values()].map((done) => done.promise));
  };
}
