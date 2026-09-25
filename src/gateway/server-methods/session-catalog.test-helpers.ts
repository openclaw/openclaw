import { afterEach, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{
    pluginId?: string;
    pluginName?: string;
    provider: SessionCatalogProvider;
    rootDir?: string;
    source?: string;
  }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  recordSessionStateEvent: vi.fn(),
  upsertSessionUpstreamLink: vi.fn(),
}));
const conversationBindingMocks = vi.hoisted(() => ({
  bindPluginSessionConversation: vi.fn(async (params: { afterBind?: () => Promise<void> }) => {
    await params.afterBind?.();
    return {};
  }),
}));
vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginRegistry: () => hoisted.activeRegistry,
  getPluginRegistryForContext: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEvent: hoisted.recordSessionStateEvent,
}));

vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLink: hoisted.upsertSessionUpstreamLink,
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: conversationBindingMocks.bindPluginSessionConversation,
}));
vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileRole: vi.fn(() => null),
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
const { markPluginRegistryActive } = await import("../../plugins/registry-lifecycle.js");
const { bindPluginRegistryRuntime } = await import("../../plugins/registry-runtime-binding.js");
const { createPluginRuntime } = await import("../../plugins/runtime/index.js");
const { resolveRegisteredCatalogCreateTarget, sessionCatalogHandlers } =
  await import("./session-catalog.js");

let sessionStore: Record<string, SessionEntry> = {};
const projections = new Set<ReturnType<typeof createSessionRowProjectionFixture>>();
afterEach(() => {
  for (const projection of projections) {
    projection.dispose();
  }
  projections.clear();
});

export function setSessionCatalogEntries(
  entries: Array<{ sessionKey: string; entry: Partial<SessionEntry> }>,
) {
  const next = Object.fromEntries(
    entries.map(({ sessionKey, entry }) => [
      sessionKey,
      { sessionId: sessionKey, updatedAt: 1, ...entry },
    ]),
  );
  for (const projection of projections) {
    for (const key of new Set([...Object.keys(sessionStore), ...Object.keys(next)])) {
      projection.setEntry(key, next[key]);
    }
  }
  sessionStore = next;
}

export function createSessionCatalogTestContext(
  config: OpenClawConfig = {},
  overrides: Record<string, unknown> = {},
) {
  const projection = createSessionRowProjectionFixture({ cfg: config, store: sessionStore });
  projections.add(projection);
  return bindSessionRowProjection(
    { getRuntimeConfig: () => config, ...overrides },
    () => projection,
  );
}

export function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

export async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string; connectionSignal?: AbortSignal },
  contextOverrides: Record<string, unknown> = {},
) {
  const pending = startCall(method, params, config, client, contextOverrides);
  await pending.completion;
  return pending.respond;
}

export function startCall(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string; connectionSignal?: AbortSignal },
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers[method]?.({
      params,
      respond,
      client,
      context: createSessionCatalogTestContext(config, contextOverrides),
    } as never),
  );
  return { completion, respond };
}

export function resetSessionCatalogTestState() {
  hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
  markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
  hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
  sessionStore = {};
  hoisted.recordSessionStateEvent.mockClear();
  hoisted.upsertSessionUpstreamLink.mockClear();
  conversationBindingMocks.bindPluginSessionConversation.mockClear();
}

export {
  bindPluginRegistryRuntime,
  conversationBindingMocks,
  createPluginRuntime,
  hoisted,
  markPluginRegistryActive,
  resolveRegisteredCatalogCreateTarget,
  sessionCatalogHandlers,
};
export type { PluginRegistry, SessionCatalogProvider };
