import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import {
  captureSystemEventStoreCurrentCheck,
  getSystemEventStorePath,
  prepareSystemEventStorePath,
  publishSystemEventStoreResolver,
} from "../../infra/system-event-ownership.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
  type SessionStorePathScope,
} from "./paths.js";
import {
  prepareSqliteTargetFromSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "./session-sqlite-target.js";

export function resolvePhysicalSessionStorePath(
  scope: SessionStorePathScope,
  cfg?: OpenClawConfig,
): string {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveIdentityPathViaExistingAncestorSync(
    resolveSqliteTargetFromSessionStorePath(resolveSessionStorePathForScope(scope, cfg), {
      ...scope,
      agentId,
    }).path,
  );
}

/** Prepare ownership in the read worker before resolving the physical path identity. */
export async function preparePhysicalSessionStorePath(
  scope: SessionStorePathScope,
  cfg?: OpenClawConfig,
): Promise<string> {
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  const target = await prepareSqliteTargetFromSessionStorePath(
    resolveSessionStorePathForScope(scope, cfg),
    { agentId, env: scope.env },
  );
  return resolveIdentityPathViaExistingAncestorSync(target.path);
}

export function publishSystemEventStoreConfig(cfg: OpenClawConfig): void {
  const env = { ...process.env };
  const paths = new Map<string, string>();
  const resolve = (sessionKey: string, owner?: string) => {
    const agentId = resolveAgentIdFromSessionKey(sessionKey, owner);
    const scope = { sessionKey, agentId, env };
    const key = JSON.stringify([agentId, resolveSessionStorePathForScope(scope, cfg)]);
    return { scope, key };
  };
  publishSystemEventStoreResolver(
    (sessionKey, owner) => {
      const { scope, key } = resolve(sessionKey, owner);
      if (!paths.has(key)) {
        paths.set(key, resolvePhysicalSessionStorePath(scope, cfg));
      }
      return paths.get(key)!;
    },
    async (sessionKey, owner) => {
      const { scope, key } = resolve(sessionKey, owner);
      if (!paths.has(key)) {
        const prepared = await preparePhysicalSessionStorePath(scope, cfg);
        // A synchronous sibling may already have installed the same owner's selection.
        if (!paths.has(key)) {
          paths.set(key, prepared);
        }
      }
      return paths.get(key)!;
    },
  );
}

export function captureSessionWatcherStorePaths(
  keys: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
) {
  return Object.fromEntries(
    keys
      .filter((key) => parseAgentSessionKey(key) != null)
      .map((sessionKey) => [
        sessionKey,
        getSystemEventStorePath(sessionKey) ?? resolvePhysicalSessionStorePath({ sessionKey, env }),
      ]),
  );
}

export type PreparedSessionWatcherStorePaths = {
  paths: Record<string, string>;
  assertCurrent(): void;
};

/** Prepare exact watcher stores and retain their owner checks through worker admission. */
export async function prepareSessionWatcherStorePaths(
  keys: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<PreparedSessionWatcherStorePaths> {
  const checks: Array<() => void> = [];
  const results = await Promise.allSettled(
    keys
      .filter((key) => parseAgentSessionKey(key) != null)
      .map(async (sessionKey) => {
        const isStoreCurrent = captureSystemEventStoreCurrentCheck(sessionKey);
        const pathname = await (prepareSystemEventStorePath(sessionKey) ??
          preparePhysicalSessionStorePath({ sessionKey, env }));
        const check = () => {
          if (!isStoreCurrent(pathname)) {
            throw new Error("Session signal lost its watcher store");
          }
        };
        check();
        checks.push(check);
        return [sessionKey, pathname] as const;
      }),
  );
  return {
    paths: Object.fromEntries(
      results.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }
        return result.value;
      }),
    ),
    assertCurrent() {
      for (const check of checks) {
        check();
      }
    },
  };
}

export function resolveSessionStorePathForScope(
  scope: SessionStorePathScope,
  config?: OpenClawConfig,
): string {
  const explicitStorePath = resolveExplicitSessionStorePathForScope(scope);
  if (explicitStorePath) {
    return explicitStorePath;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  return resolveSessionStorePathCore((config ?? getRuntimeConfig()).session?.store, {
    agentId,
    env: scope.env,
  });
}
