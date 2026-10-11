import { vi } from "vitest";
import { resolveSessionEntryResetFreshness } from "../../config/sessions/entry-freshness.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export function createPluginSessionRuntimeMock() {
  return {
    resolveStorePath: vi.fn<PluginRuntime["channel"]["session"]["resolveStorePath"]>(
      () => "/tmp/sessions.json",
    ),
    readSessionUpdatedAt: vi.fn<PluginRuntime["channel"]["session"]["readSessionUpdatedAt"]>(
      () => undefined,
    ),
    readSessionUpdatedAtAsync: vi.fn<
      PluginRuntime["channel"]["session"]["readSessionUpdatedAtAsync"]
    >(async () => undefined),
    recordSessionMetaFromInbound:
      vi.fn<PluginRuntime["channel"]["session"]["recordSessionMetaFromInbound"]>(),
    recordInboundSession: vi.fn<PluginRuntime["channel"]["session"]["recordInboundSession"]>(),
    updateLastRouteWithAuthority:
      vi.fn<PluginRuntime["channel"]["session"]["updateLastRouteWithAuthority"]>(),
    updateLastRoute: vi.fn<PluginRuntime["channel"]["session"]["updateLastRoute"]>(),
    resolveEntryResetFreshness: vi.fn(resolveSessionEntryResetFreshness),
    resolveEntryResetFreshnessAsync: vi.fn(
      async (...params: Parameters<typeof resolveSessionEntryResetFreshness>) =>
        resolveSessionEntryResetFreshness(...params),
    ),
  };
}
