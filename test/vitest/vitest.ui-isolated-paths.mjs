import { resolveUiTypeScriptPath } from "./vitest.ui-paths.mjs";

// The shared UI runner reuses its module graph across fresh jsdom registries.
// Tests in this list depend on module singletons or custom-element registration
// matching the current registry, so they need a fresh graph in the isolated lane.
export const uiIsolatedTestFiles = [
  "ui/src/app/app-host.server-prefs.test.ts",
  "ui/src/app/bootstrap.gateway-credentials.test.ts",
  "ui/src/app/bootstrap.test.ts",
  "ui/src/app/router-outlet.test.tsx",
  "ui/src/components/app-sidebar-native-gateways.test.ts",
  // The cold-view proof holds imports that other sidebar suites already load.
  "ui/src/components/app-sidebar-lazy-views.test.tsx",
  // Captured native frame functions must belong to this file's JSDOM window.
  "ui/src/components/app-sidebar.catalog-events.test.ts",
  // The catalog suite exceeds the CI deadline in a shared Bun worker.
  "ui/src/components/app-sidebar.catalog.test.ts",
  // The held MCP renderer import must not be preloaded by another suite.
  "ui/src/components/board/board-widget-cell-mcp-app.test.tsx",
  // Holds the report chunk before first import to prove the cold widget boundary.
  "ui/src/components/board/board-widget-cell-plugin.test.ts",
  "ui/src/components/board/core-board-widget.test.tsx",
  "ui/src/components/gateway-url-confirmation.test.ts",
  "ui/src/components/link-reader-title-tooltip.test.ts",
  // Import rejection fixtures must not poison the shared module registry.
  "ui/src/components/lazy-entry-feedback.test.tsx",
  "ui/src/components/sidebar-attention-lazy-failure.test.ts",
  "ui/src/components/markdown-tables.test.ts",
  "ui/src/components/mcp-app-bridge.test.ts",
  "ui/src/components/mcp-app-panel.test.tsx",
  "ui/src/components/mcp-app-view-lifecycle.test.ts",
  "ui/src/components/mcp-app-view.test.ts",
  "ui/src/components/promise-modal-host-loading.test.ts",
  "ui/src/components/resizable-divider.test.ts",
  "ui/src/components/sidebar-update-card.test.ts",
  "ui/src/components/tooltip-loading.test.ts",
  "ui/src/components/viewer-facepile.test.ts",
  "ui/src/pages/agents/memory/memory-panel.test.ts",
  "ui/src/pages/chat/chat-outbox-recovery-owner.test.ts",
  "ui/src/pages/chat/chat-outbox-recovery.test.ts",
  "ui/src/pages/chat/chat-page-attachment-handoff.test.ts",
  "ui/src/pages/chat/chat-page-draft-commit.test.ts",
  "ui/src/pages/chat/chat-page-session-refresh.test.ts",
  "ui/src/pages/chat/chat-page.test.ts",
  "ui/src/pages/chat/chat-pane-attachment-handoff.test.ts",
  "ui/src/pages/chat/chat-pane-board.test.ts",
  "ui/src/pages/chat/chat-pane-catalog.test.ts",
  "ui/src/pages/chat/chat-pane-history.test.ts",
  "ui/src/pages/chat/chat-pane-identity.test.ts",
  "ui/src/pages/chat/chat-pane-keyboard-focus.test.ts",
  "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
  "ui/src/pages/chat/chat-pane-pull-requests.test.ts",
  "ui/src/pages/chat/chat-pane-retained-presentation.test.ts",
  "ui/src/pages/chat/chat-pane-retention.test.ts",
  // Request-level speed proof replaces the provider SDK transport and SQL asset loaders.
  "ui/src/pages/chat/chat-pane-session-controls.permissions.node.test.ts",
  "ui/src/pages/chat/chat-pane-swarm-startup.test.ts",
  "ui/src/pages/chat/chat-pane.read-marker.test.ts",
  "ui/src/pages/chat/chat-pane.session-discussion.test.ts",
  "ui/src/pages/chat/chat-pane.test.ts",
  "ui/src/pages/chat/chat-pane-tool-icons.test.tsx",
  // Holds the editor import before first use; other comment suites load it eagerly.
  "ui/src/pages/chat/components/chat-annotation-lazy.test.ts",
  "ui/src/pages/chat/components/chat-transcript-controller.test.ts",
  "ui/src/pages/chat/components/chat-transcript-geometry.test.ts",
  "ui/src/pages/chat/components/chat-transcript-invalidation.test.ts",
  "ui/src/pages/chat/components/chat-transcript-message-reveal.test.ts",
  "ui/src/pages/chat/components/chat-transcript-render.test.ts",
  // Deferred widget module mocks must not poison later lazy consumers.
  "ui/src/pages/chat/components/widget-registration.test.tsx",
  "ui/src/pages/config/config-page.custom-theme.test.ts",
  "ui/src/pages/config/memory-mutation-owner.test.ts",
  "ui/src/pages/config/memory-page.test.ts",
  "ui/src/pages/new-session/draft-persistence.test.ts",
  "ui/src/pages/new-session/new-session-attachment-lazy.test.ts",
  "ui/src/pages/sessions/sessions-page.archived.test.ts",
].map((file) => resolveUiTypeScriptPath(file));

const uiIsolatedTestFileSet = new Set(uiIsolatedTestFiles);

export function isUiIsolatedTestFile(value) {
  return uiIsolatedTestFileSet.has(value.replaceAll("\\", "/"));
}
