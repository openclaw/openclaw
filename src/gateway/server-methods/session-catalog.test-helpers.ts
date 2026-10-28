import { afterEach, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import type { GatewayClient } from "./types.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<
    Partial<PluginRegistry["sessionCatalogs"][number]> & { provider: SessionCatalogProvider }
  >;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  recordSessionStateEventAsync: vi.fn(async () => undefined),
  upsertSessionUpstreamLink: vi.fn(),
  prepareShellPathFromLoginShell: vi.fn(async () => null as string | null),
}));
vi.mock("../../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/shell-env.js")>()),
  prepareShellPathFromLoginShell: hoisted.prepareShellPathFromLoginShell,
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

// mock-isolation: Catalog RPC fixtures control signal settlement without opening shared-state workers.
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEventAsync: hoisted.recordSessionStateEventAsync,
}));

// mock-isolation: Record catalog link requests without opening the persistence owner.
vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLinkAsync: hoisted.upsertSessionUpstreamLink,
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: conversationBindingMocks.bindPluginSessionConversation,
}));
// mock-isolation: Control the synthetic catalog's sharing policy without opening profile storage.
vi.mock("../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
  readResidentUserProfileAliases: (id: string) => new Set([id]),
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
  clearRuntimeConfigSnapshot();
});

export function setSessionCatalogEntries(
  entries: Array<{ sessionKey: string; entry: Partial<SessionEntry> }>,
) {
  const next = Object.fromEntries(
    entries.map(({ sessionKey: key, entry }) => [key, { sessionId: key, updatedAt: 1, ...entry }]),
  );
  for (const projection of projections) {
    for (const key of new Set([...Object.keys(sessionStore), ...Object.keys(next)])) {
      projection.setEntry(key, next[key]);
    }
  }
  sessionStore = next;
}

export async function call(...args: Parameters<typeof startCall>) {
  const { completion, respond } = startCall(...args);
  await completion;
  return respond;
}

export function startCall(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: Pick<GatewayClient, "connect"> &
    Partial<Pick<GatewayClient, "connId" | "connectionSignal">>,
  contextOverrides: Record<string, unknown> = {},
) {
  setRuntimeConfigSnapshot(config);
  const projection = createSessionRowProjectionFixture({ cfg: config, store: sessionStore });
  projections.add(projection);
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers[method]?.({
      params,
      respond,
      client,
      context: bindSessionRowProjection(
        { getRuntimeConfig: () => config, ...contextOverrides },
        () => projection,
      ),
    } as never),
  );
  return { completion, respond };
}

export function resetSessionCatalogTestState() {
  hoisted.prepareShellPathFromLoginShell.mockReset().mockResolvedValue(null);
  hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
  markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
  hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
  sessionStore = {};
  hoisted.recordSessionStateEventAsync.mockClear();
  hoisted.upsertSessionUpstreamLink.mockClear();
  conversationBindingMocks.bindPluginSessionConversation.mockClear();
}

export {
  bindPluginRegistryRuntime,
  conversationBindingMocks,
  createPluginRuntime,
  hoisted,
  resolveRegisteredCatalogCreateTarget,
  sessionCatalogHandlers,
};
export type { PluginRegistry, SessionCatalogProvider };
