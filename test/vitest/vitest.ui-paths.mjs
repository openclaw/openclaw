import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const inventories = new Map();

// Share one process snapshot across UI ownership and fast-lane discovery.
export function getRepositoryFileInventory(directory = repoRoot) {
  const cwd = resolve(directory);
  if (!inventories.has(cwd)) {
    // Share working-tree facts without probing each inventoried owner. Include
    // untracked destinations and remove indexed paths deleted by unstaged renames.
    const result = spawnSync(
      "git",
      ["ls-files", "--cached", "--others", "--deleted", "--exclude-standard", "-t", "-z"],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let files = null;
    if (!result.error && result.status === 0) {
      const entries = result.stdout.split("\0").filter(Boolean);
      files = new Set(entries.map((entry) => entry.slice(2)));
      for (const entry of entries) {
        if (entry.startsWith("R ")) {
          files.delete(entry.slice(2));
        }
      }
    }
    inventories.set(cwd, files);
  }
  return inventories.get(cwd);
}

/** Resolve an inventoried owner after a TS/TSX rename, retaining absent paths. */
export function resolveUiTypeScriptPath(file, cwd = repoRoot) {
  if (!/\.tsx?$/u.test(file)) {
    return file;
  }
  const inventory = getRepositoryFileInventory(cwd);
  const exists = (candidate) =>
    inventory ? inventory.has(candidate) : existsSync(resolve(cwd, candidate));
  if (exists(file)) {
    return file;
  }
  const alternate = file.endsWith(".tsx") ? file.slice(0, -1) : `${file}x`;
  return exists(alternate) ? alternate : file;
}

/** Watch both extensions, including deleted paths that cannot be resolved on disk. */
export function uiTypeScriptPathGlob(file) {
  return file.replace(/\.tsx?$/u, ".{ts,tsx}");
}

// Wall-clock render budgets must not compete with the UI's Chromium workers.
export const uiTimingTestFiles = ["ui/src/components/markdown.progress.node.test.ts"].map((file) =>
  resolveUiTypeScriptPath(file),
);

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
  "ui/src/styles/corner-shape.browser.test.ts",
  "ui/src/styles/cursor-policy.browser.test.ts",
  "ui/src/styles/chat-file-link-presentation.browser.test.ts",
  "ui/src/styles/chat-github-link-presentation.browser.test.ts",
  "ui/src/styles/shimmer.browser.test.ts",
  "ui/src/styles/forced-colors-indicators.browser.test.ts",
  "ui/src/styles/sr-only.browser.test.ts",
].map((file) => resolveUiTypeScriptPath(file));

export function isUiBrowserTestFile(relative) {
  return (
    isUiTestTarget(relative) &&
    !/[*?[\]{}]|[@+!]\(/u.test(relative) &&
    /\.browser\.test\.tsx?$/u.test(relative) &&
    !uiNodeDrivenBrowserTestFiles.some(
      (file) => file.replace(/\.tsx$/u, ".ts") === relative.replace(/\.tsx$/u, ".ts"),
    )
  );
}

export const pluginControlUiPathGlob = "extensions/*/browser/**";
const controlUiRoots = ["ui/src", "extensions/*/browser"];
// Git's :(glob) pathspecs consume these too and do not expand braces.
export const controlUiTestGlobs = controlUiRoots.flatMap((root) =>
  ["ts", "tsx"].map((extension) => `${root}/**/*.test.${extension}`),
);
export const controlUiE2eTestGlobs = controlUiRoots.flatMap((root) =>
  ["ts", "tsx"].map((extension) => `${root}/**/*.e2e.test.${extension}`),
);

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
    /\.test\.tsx?$/u.test(relative) &&
    !/\.e2e\.test\.tsx?$/u.test(relative)
  );
}

export const uiE2eRealGatewayTestFiles = [
  "ui/src/e2e/background-work.real-gateway.e2e.test.ts",
  "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-roster-request-rate.real-gateway.e2e.test.ts",
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
  "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-stop-owned-exec.real-gateway.e2e.test.ts",
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
].map((file) => resolveUiTypeScriptPath(file));

// New real-Gateway files stay serial until their shared readers/writers are audited.
// Listed fixtures own their HOME, state, ports, and cleanup; UI bytes are either
// borrowed from the invocation preview or read by their prepared Gateway child.
export const uiE2ePrebuiltParallelTestFiles = [
  "ui/src/e2e/activity-run-inspector.real-gateway.e2e.test.ts",
  "ui/src/e2e/agent-file-lifecycle.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-agent-avatar.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-composer-websearch-kill-switch.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-flow.catalog-bootstrap.e2e.test.ts",
  "ui/src/e2e/chat-loading-performance.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-project-media.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-stop-finished-run.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-thinking-metadata.real-gateway.e2e.test.ts",
  "ui/src/e2e/chat-widget-sandbox.real-gateway.e2e.test.ts",
  "ui/src/e2e/command-palette-catalog.real-gateway.e2e.test.ts",
  "ui/src/e2e/control-ui-auth-transports.e2e.test.ts",
  "ui/src/e2e/cron-duration-save.real-gateway.e2e.test.ts",
  "ui/src/e2e/device-alias-rename.real-gateway.e2e.test.ts",
  "ui/src/e2e/logs-lifecycle.e2e.test.ts",
  "ui/src/e2e/model-api-keys.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-catalog-partial-refresh.real-gateway.e2e.test.ts",
  "ui/src/e2e/model-picker-search.real-gateway.e2e.test.ts",
  "ui/src/e2e/profile-page.real-gateway.e2e.test.ts",
  "ui/src/e2e/quota-reset-status.real-gateway.e2e.test.ts",
  "ui/src/e2e/session-progress-hovercard.real-gateway.e2e.test.ts",
  "ui/src/e2e/usage-sessions-owner-attribution.e2e.test.ts",
  "ui/src/e2e/worker-initial-setup.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-media-transcript.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/session-host-command-state.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-openclaw-delegation.real-gateway.e2e.test.ts",
  "extensions/qa-lab/src/control-ui-automation-management.real-gateway.e2e.test.ts",
].map((file) => resolveUiTypeScriptPath(file));
