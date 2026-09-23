// Wall-clock render budgets must not compete with the UI's Chromium workers.
export const uiTimingTestFiles = ["ui/src/components/markdown.progress.node.test.ts"];

// These files launch Playwright from Node; all other .browser tests run in Chromium.
export const uiNodeDrivenBrowserTestFiles = [
  "ui/src/pages/chat/chat-responsive.browser.test.ts",
  "ui/src/pages/chat/chat-search-layout.browser.test.ts",
  "ui/src/pages/chat/chat-footer-layout.browser.test.ts",
  "ui/src/pages/chat/chat-working-indicator.browser.test.ts",
  "ui/src/pages/chat/chat-composer-undo-redo.browser.test.ts",
  "ui/src/pages/chat/components/chat-swarm-progress.browser.test.ts",
  "ui/src/components/form-controls.browser.test.ts",
  "ui/src/components/sidebar-footer-layout.browser.test.ts",
  "ui/src/pages/sessions/view.browser.test.ts",
  "ui/src/styles/corner-shape.browser.test.ts",
  "ui/src/styles/cursor-policy.browser.test.ts",
  "ui/src/styles/chat-file-link-presentation.browser.test.ts",
  "ui/src/styles/chat-github-link-presentation.browser.test.ts",
  "ui/src/styles/shimmer.browser.test.ts",
  "ui/src/styles/sr-only.browser.test.ts",
];

export function isUiBrowserTestFile(relative) {
  return (
    isUiTestTarget(relative) &&
    !/[*?[\]{}]|[@+!]\(/u.test(relative) &&
    relative.endsWith(".browser.test.ts") &&
    !uiNodeDrivenBrowserTestFiles.includes(relative)
  );
}

export const pluginControlUiPathGlob = "extensions/*/browser/**";
export const controlUiTestGlobs = ["ui/src/**/*.test.ts", "extensions/*/browser/**/*.test.ts"];
export const controlUiE2eTestGlobs = [
  "ui/src/**/*.e2e.test.ts",
  "extensions/*/browser/**/*.e2e.test.ts",
];

/** Browser plugin source and tests share the Control UI owner, regardless of plugin id.
 * @param {string} file
 */
export function isPluginControlUiPath(file) {
  return /^extensions\/[^/]+\/browser(?:\/|$)/u.test(file);
}

/** @param {string} file */
export function isControlUiSourcePath(file) {
  return file.startsWith("ui/src/") || isPluginControlUiPath(file);
}

/** @param {string} relative */
export function isUiTestTarget(relative) {
  return (
    isControlUiSourcePath(relative) &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}

export const uiE2eRealGatewayTestFiles = [
  "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-api-keys.real-gateway.e2e.test.ts",
  "ui/src/e2e/provider-browser-login.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-catalog-partial-refresh.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-flow.catalog-bootstrap.e2e.test.ts",
  "ui/src/e2e/worker-initial-setup.real-gateway.e2e.test.ts",
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-composer-websearch-kill-switch.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-reconnect-continuity.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-collaborator-scroll.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-thinking-metadata.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-tts-supplement.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-alias-rename.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-platform-family.real-gateway.e2e.test.ts",
  "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/mcp-app-conformance.e2e.test.ts",
  "ui/src/e2e/model-picker-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/profile-page.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-pr-reader-lifetime.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
];
