import { randomUUID } from "node:crypto";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginRecord } from "./loader-records.js";
import { resolveMemoryAudienceFromEntry } from "./memory-audience.js";
import type {
  MemoryAudience,
  MemoryCallerContext,
  MemoryProviderHandle,
} from "./memory-provider-types.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRegistryOwner } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

export const AUDIENCE_ROOT_KEY = "agent:main:root";
export const AUDIENCE_CHILD_KEY = "agent:main:subagent:child";
export const NATIVE_PROVIDER_ID = "partitioned-memory";

export type ChildLineage = {
  audience: MemoryAudience;
  root: SessionEntry;
  child: SessionEntry;
  write: (sessionKey: string, entry: SessionEntry) => void;
  storePath: string;
};

/** Commit real lineage and mint its audience from the admitted child row. */
export async function withChildAudience(
  rootSenderIsOwner: boolean,
  run: (lineage: ChildLineage) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const write = (sessionKey: string, entry: SessionEntry) =>
      replaceSessionEntrySync({ agentId: "main", sessionKey, env }, entry);
    const entry = (fields: Partial<SessionEntry>): SessionEntry => ({
      sessionId: randomUUID(),
      lifecycleRevision: randomUUID(),
      updatedAt: 1,
      ...fields,
    });
    const root = entry({ chatType: "direct" });
    const child = entry({
      spawnedBy: AUDIENCE_ROOT_KEY,
      parentSessionKey: AUDIENCE_ROOT_KEY,
      spawnedBySessionId: root.sessionId,
      parentSessionLifecycleRevision: root.lifecycleRevision,
      spawnedBySenderIsOwner: rootSenderIsOwner,
    });
    write(AUDIENCE_ROOT_KEY, root);
    write(AUDIENCE_CHILD_KEY, child);
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const resolution = await resolveMemoryAudienceFromEntry(
      {
        agentId: "main",
        sessionKey: AUDIENCE_CHILD_KEY,
        sessionId: child.sessionId,
        senderIsOwner: false,
        storePath,
      },
      child,
    );
    if (resolution.status !== "granted") {
      throw new Error(resolution.reason);
    }
    using _ = { [Symbol.dispose]: resolution.release };
    await run({ audience: resolution.audience, root, child, write, storePath });
  });
}

export function childMemoryContext(audience: MemoryAudience): MemoryCallerContext {
  return {
    authority: { kind: "session", sessionKey: AUDIENCE_CHILD_KEY, sandboxed: false, audience },
    assertCurrent() {},
  };
}

/** Register a selected native provider; preserve the host-supplied open context. */
export async function withNativeMemoryProvider<T>(
  open: (context: MemoryCallerContext) => MemoryProviderHandle,
  action: () => Promise<T>,
): Promise<T> {
  const registry = createTestPluginRegistry();
  const record = createPluginRecord({
    id: NATIVE_PROVIDER_ID,
    source: "fixture",
    origin: "config",
    enabled: true,
    configSchema: false,
  });
  record.kind = "memory";
  record.memorySlotSelected = true;
  registry.registry.plugins.push(record);
  registry.createApi(record, { config: {} }).registerMemoryCapability({
    providerRuntime: { open: async ({ context }) => ({ provider: open(context) }) },
  });
  const owner = createPluginRegistryOwner(registry.registry);
  try {
    return await withPluginRuntimeRegistryScope(registry.registry, action);
  } finally {
    await owner.close();
  }
}
