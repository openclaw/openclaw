// Control UI config module wires control ui chunking behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type ResolvedConfig } from "vite";
import {
  resolvedLocaleConfigHintsModulePrefix,
  resolvedLocaleNamespaceModulePrefix,
} from "./control-ui-locales.ts";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
// Fresh /new and /chat captures separate shared boot work from route-only work.
// The generator disables these groups so stale entries cannot feed back into it.
const controlUiBootModules = JSON.parse(
  fs.readFileSync(path.join(configDir, "control-ui-boot-modules.json"), "utf8"),
) as Record<"shared" | "new" | "chat", string[]> & {
  entries: Record<"shared" | "new" | "chat", string[]>;
};

const chatVisibleModules = new Set([
  "ui/src/pages/chat/components/chat-tool-card-chrome.tsx",
  "ui/src/pages/chat/components/chat-tool-outcome-summary.solid.tsx",
  "ui/src/pages/chat/components/chat-tool-render-model.ts",
  "ui/src/pages/chat/components/chat-message-bubble-tools.tsx",
  "ui/src/pages/chat/components/chat-permission-card.tsx",
  "ui/src/pages/chat/components/chat-tool-content.solid.tsx",
  "ui/src/pages/chat/components/chat-tool-cards.solid.tsx",
  "ui/src/pages/chat/components/chat-message-activity-operation.tsx",
  "ui/src/pages/chat/components/chat-diff-stat.solid.tsx",
  "ui/src/pages/chat/components/chat-tool-row-presentation.ts",
  "ui/src/lib/chat/tool-display-identity.ts",
  "ui/src/lib/chat/tool-call-input.ts",
  "src/agents/tool-display-name.ts",
  "ui/src/i18n/locales/en-chat-details.ts",
  "ui/src/pages/chat/components/chat-environment-content.tsx",
]);

const bootEntryRoutes = new Map(
  (["shared", "new", "chat"] as const).flatMap((route) =>
    controlUiBootModules.entries[route].map((id) => [id, route] as const),
  ),
);

export function controlUiBootEntryRoute(id: string) {
  return bootEntryRoutes.get(controlUiBootManifestKey(id));
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

export function controlUiBootManifestKey(id: string): string {
  // Canonical manifest key: vendor modules key from their innermost
  // node_modules entry so pnpm virtual-store paths match; first-party modules
  // key repo-relative.
  const stripped = id.replace(/[?#].*$/u, "");
  const normalized = normalizeModuleId(stripped);
  const vendorIndex = normalized.lastIndexOf("/node_modules/");
  if (vendorIndex !== -1) {
    return `node_modules/${normalized.slice(vendorIndex + "/node_modules/".length)}`;
  }
  return normalizeModuleId(path.relative(repoRoot, stripped));
}

function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

export const controlUiLocaleConfigHintsChunkPrefix = "locale-config-hints-";

export function controlUiStableChunkName(id: string): string | undefined {
  const normalized = normalizeModuleId(id);

  switch (controlUiBootManifestKey(id)) {
    case "ui/src/pages/chat/components/chat-ci-automation-control.tsx":
    case "ui/src/pages/chat/components/chat-ci-automation.tsx":
    case "ui/src/pages/chat/components/chat-ci-details.tsx":
    case "ui/src/pages/chat/components/chat-ci-disclosure.ts":
    case "ui/src/pages/chat/components/chat-ci-gateway-updates.ts":
    case "ui/src/i18n/locales/en-chat-ci.ts":
    case "ui/src/lib/session-pr-automation.ts":
    case "ui/src/lib/session-pr-automation-spec.ts":
      // Shared readers load with the first CI panel; row copy controls remain independent.
      return "chat-ci-automation-control";
    case "ui/src/styles/agents.css":
    case "ui/src/styles/agent-emoji-picker.css":
    case "ui/src/styles/multi-select.css":
      // Overview always uses these controls; share styles without loading route renderers.
      return "agents-styles";
    case "ui/src/pages/chat/components/chat-details-people.css":
    case "ui/src/pages/chat/components/chat-outputs.css":
    case "ui/src/pages/chat/components/chat-details-environment-desktop.css":
      // Share styles without making Outputs import the Details renderer.
      return "chat-details-styles";
    case "node_modules/@tanstack/virtual-core/dist/esm/index.js":
    case "node_modules/@tanstack/virtual-core/dist/esm/lazy-measurements.js":
    case "node_modules/@tanstack/virtual-core/dist/esm/utils.js":
      return "virtual-core-runtime";
    case "ui/src/pages/claws/creator-flow.ts":
    case "ui/src/pages/claws/draft-navigation.ts":
    case "ui/src/i18n/locales/en-agents-home.ts":
      // Chat and the roster co-load both; Claws accepts the extra virtualizer bytes.
      return "virtual-core-runtime";
    case "src/shared/dedupe-by-key.ts":
      // Config search shares this helper without loading optional session UI.
      return "control-ui-boot-shared";
    case "ui/src/components/session-git-diff.tsx":
    case "ui/src/lib/sessions/usage.ts":
    case "src/shared/weak-owner-map.ts":
    case "src/shared/assistant-display-content.ts":
    case "src/shared/agent-run-status.ts":
    case "ui/src/app/assistant-media.ts":
    case "ui/src/lib/image-download.ts":
    case "ui/src/lib/download.ts":
    case "src/shared/markdown-code.ts":
    case "src/shared/html-escape.ts":
    case "src/shared/shell-quote.ts":
    case "src/utils/message-channel-constants.ts":
    case "src/utils/string-readers.ts":
    case "ui/src/components/file-kind.ts":
    case "ui/src/lib/reactive/application-native.ts":
    case "ui/src/lib/reactive/visible-poll.ts":
    case "ui/src/lib/chat/follow-up-mode.ts":
    case "ui/src/lib/sessions/context-budget.ts":
    case "ui/src/lib/sessions/session-archive-reason.ts":
    case "ui/src/lib/sessions/session-message-subscriptions.runtime.ts":
    case "packages/gateway-client/src/session-subscriptions.ts":
    case "ui/src/pages/labs/labs-feature-state.ts":
    case "ui/src/pages/labs/claws-lab-feature.ts":
    case "ui/src/i18n/locales/en-session-skill-library.ts":
    case "ui/src/pages/plugins/detail-tabs.ts":
    case "ui/src/components/confirm-dialog.ts":
    case "ui/src/components/confirm-dialog-loading.tsx":
    case "ui/src/components/menu-surface.ts":
    case "ui/src/components/session-menu-access.ts":
    case "ui/src/components/session-menu-data.ts":
    case "ui/src/components/session-placement-action.ts":
    case "ui/src/lib/editor-links.ts":
    case "ui/src/lib/sessions/session-menu-navigation.ts":
    case "src/config/required-worker-profile.ts":
    case "ui/src/app/native-editor-locality.runtime.ts":
    case "ui/src/app/native-gateways.runtime.ts":
    case "ui/src/pages/plugins/icon-loader.ts":
    case "ui/src/pages/plugins/plugin-icon-owner.ts":
    case "ui/src/components/desktop/desktop-source.ts":
    case "ui/src/components/solid/panel-loading-skeleton.tsx":
    case "ui/src/lib/session-progress-cards.ts":
      // These shared helpers load together in Chat without retaining its renderers.
      return "deferred-ui-support";
    case "ui/src/styles/panel-loading-skeleton.css":
      // Keep the inline string with its renderer so recursive Chat grouping cannot capture it.
      return "deferred-ui-support";
    case "ui/src/components/mcp-app-catalog.tsx":
    case "ui/src/lib/mcp-app-catalog.ts":
    case "ui/src/i18n/locales/en-mcp-app.ts":
    case "ui/src/components/mcp-app-launch.ts":
    case "ui/src/components/mcp-app-view-lazy.ts":
    case "ui/src/lib/sessions/session-create-params.ts":
    case "packages/gateway-protocol/src/question-media.ts":
      // Shared catalogs and session parameters must not pull Chat into other routes.
      return "deferred-ui-support";
    case "ui/src/lib/page-request.ts":
    case "ui/src/lib/worktrees/create-worktree.ts":
    case "ui/src/pages/new-session/rejected-initial-turn.ts":
    case "ui/src/lib/model-catalog-reader.ts":
    case "ui/src/components/lobster-pet-contract.ts":
    case "ui/src/lib/mac-form-factor.ts":
    case "ui/src/pages/new-session/model-location.ts":
    case "ui/src/components/agent-select.tsx":
    case "ui/src/components/agent-select-registration.ts":
    case "ui/src/lib/sessions/session-placement-recovery.ts":
    case "ui/src/components/solid/connect-command.tsx":
      // Creation fetches these together; keep their compression without a whole route.
      return "route-controls-runtime";
    case "ui/src/components/solid/hub-page-header.tsx":
    case "ui/src/components/solid/settings-workspace.tsx":
    case "ui/src/components/solid/settings-select.tsx":
      // Only page chrome belongs here; shared controls also serve lazy Chat panels.
      return "route-chrome";
    case "node_modules/typebox/build/guard/guard.mjs":
    case "node_modules/typebox/build/guard/globals.mjs":
    case "node_modules/typebox/build/guard/index.mjs":
    case "node_modules/typebox/build/guard/unicode/unicode.mjs":
    case "node_modules/typebox/build/guard/unicode/unicode_segment.mjs":
      // Protocol consumers share guards without evaluating the Chat route.
      return "deferred-ui-support";
    case "packages/markdown-core/src/assistant-transcript.ts":
    case "packages/markdown-core/src/assistant-transcript-headers.ts":
    case "packages/markdown-core/src/html-tags.ts":
    case "packages/markdown-core/src/ir-metadata.ts":
      // Text annotations also serve plain-text consumers without loading the parser.
      return "deferred-ui-support";
    case "ui/src/pages/chat/components/chat-image-preview-size.ts":
    case "ui/src/pages/chat/components/chat-image-rendition.ts":
    case "ui/src/pages/chat/components/chat-message-image-open.ts":
    case "ui/src/pages/chat/components/chat-message-images-solid.tsx":
    case "ui/src/pages/chat/components/chat-image-actions.tsx":
    case "ui/src/pages/chat/components/chat-message-local-media.ts":
    case "ui/src/pages/chat/components/chat-message-attachment-availability.ts":
    case "ui/src/pages/chat/components/chat-media-playback.ts":
    case "ui/src/pages/chat/components/chat-message-image-loading.ts":
      return "chat-message-media-runtime";
    case "ui/src/pages/chat/chat-provider-review-controller.tsx":
      return "chat-provider-review";
    // Keep optional compression groups separate from code evaluated by text-only Chat.
    case "ui/src/pages/chat/chat-send-delivery.runtime.ts":
    case "ui/src/pages/chat/chat-send-queue-runtime.ts":
    case "ui/src/pages/chat/chat-model-recovery.runtime.ts":
    case "ui/src/pages/chat/chat-command-dispatch.runtime.ts":
    case "ui/src/pages/chat/chat-pane-session-operations.ts":
    case "ui/src/pages/chat/chat-pane-session-operations.runtime.ts":
      return "chat-interaction-runtime";
    case "ui/src/pages/chat/components/chat-context-breakdown.tsx":
    case "ui/src/pages/chat/components/chat-context-breakdown-model.ts":
    case "ui/src/pages/chat/components/chat-context-report.tsx":
    case "ui/src/pages/chat/components/chat-details-environment-body.tsx":
    case "ui/src/lib/session-context-report.ts":
      return "chat-interaction-runtime";
    case "node_modules/@solidjs/signals/dist/prod/deferred.js":
      // Route readers share this hook below without adding it to eager Solid code.
      return undefined;
    case "ui/src/pages/chat/components/chat-outputs.tsx":
      return "chat-outputs";
    case "ui/src/pages/chat/components/chat-details-people-list.tsx":
      return "chat-details-people-list";
    case "ui/src/lib/nodes/device-signing.runtime.ts":
      return "device-signing-runtime";
    case "ui/src/pages/chat/chat-live-events.runtime.ts":
    case "ui/src/pages/chat/chat-gateway.ts":
    case "ui/src/pages/chat/tool-stream.ts":
    case "ui/src/pages/chat/tool-stream-status.ts":
    case "ui/src/pages/chat/tool-stream-preamble.ts":
      return "chat-live-events-runtime";
    case "ui/src/pages/chat/chat-mobile-host.runtime.tsx":
    case "ui/src/pages/chat/chat-mobile-scroll-fades.runtime.ts":
    case "ui/src/pages/chat/components/chat-mobile-people-grid.tsx":
    case "ui/src/pages/chat/components/chat-mobile-people-grid.css":
      // Keep gesture and People implementations separate from retained header chrome.
      return "chat-mobile-runtime";
    case "ui/src/lib/device-pair-setup.ts":
      // Pairing loads on interaction; the earlier boot capture must not pull it into either route.
      return "device-pair-setup-runtime";
    case "ui/src/lib/channels/index.ts":
      // Channel owners load on their first consumer, outside earlier shared boot captures.
      return "channels-runtime";
    case "ui/src/pages/chat/talk/conversation.ts":
      return "talk-conversation-runtime";
    case "ui/src/pages/chat/chat-goal-operations.runtime.ts":
      return "chat-goal-operations-runtime";
    case "ui/src/pages/chat/chat-export.runtime.ts":
    case "ui/src/pages/chat/export.ts":
      return "chat-export-runtime";
    case "ui/src/lib/sessions/session-mutation-operations.runtime.ts":
    case "ui/src/lib/sessions/create.ts":
    case "ui/src/lib/sessions/session-patch-row-facts.ts":
    case "src/shared/session-unread.ts":
    case "ui/src/lib/sessions/session-delete-operation.ts":
      // Session actions must not import whole route chunks through earlier boot captures.
      return "session-mutation-runtime";
    case "ui/src/lib/chat/emoji.ts":
      // Typed shortcodes need Markdown context parsing; a visual picker does not.
      return "emoji-runtime";
    case "node_modules/markdown-it-emoji/lib/data/full.mjs":
      return "emoji-catalog-runtime";
    case "ui/src/components/mascot-animator.ts":
      // Only visible mascots request motion; stale boot captures must not keep it eager.
      return "mascot-motion-runtime";
    case "ui/src/components/emoji-search-panel.tsx":
    case "ui/src/styles/emoji-search-panel.css":
      return "emoji-search-panel";
    case "ui/src/pages/chat/components/chat-composer-emoji-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-emoji.tsx":
    case "ui/src/pages/chat/components/chat-composer-mention-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-mention-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-skill-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-skill-menu.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu-options.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu-dom.tsx":
    case "ui/src/pages/chat/components/chat-composer-slash-menu.tsx":
      // Share interaction-only rows without four separate preload-map entries.
      return "composer-invocation-menus";
    case "ui/src/app/app-root-focus.ts":
    case "ui/src/app/app-root-focus-view.tsx":
      return "focus-dashboard-runtime";
    case "ui/src/components/solid/gateway-url-confirmation.tsx":
      // A pending target owns this dialog; ordinary boot never requests it.
      return "gateway-confirmation-runtime";
    case "ui/src/pages/chat/route-entry.ts":
      // Pending New Session previews must render while the Chat route entry waits.
      return "chat-route-entry";
    case "ui/src/i18n/locales/en-session-organization-shared.ts":
      // Settings, New Session, and Chat share this English copy.
      return "chat-english";
    case "ui/src/pages/devices/devices-page.tsx":
      return "devices-page";
    case "ui/src/pages/plugins/plugins-page.tsx":
      return "plugins-page";
    case "ui/src/pages/cron/cron-page.tsx":
    case "ui/src/pages/cron/cron-page-state.ts":
    case "ui/src/pages/cron/cron-page-presentation.ts":
    case "ui/src/pages/cron/delivery-conversations.ts":
    case "ui/src/pages/cron/event-editor.ts":
    case "ui/src/pages/cron/event-source.ts":
    case "ui/src/pages/cron/route-model.ts":
    case "ui/src/pages/cron/run-transcript.tsx":
    case "ui/src/pages/cron/suggestions.ts":
    case "ui/src/pages/cron/view-props.ts":
    case "ui/src/pages/cron/view-controls.tsx":
    case "ui/src/pages/cron/view-job-status.tsx":
    case "ui/src/pages/cron/view-jobs-filter.tsx":
    case "ui/src/pages/cron/view-list.tsx":
    case "ui/src/pages/cron/view-runs.tsx":
    case "ui/src/pages/cron/view.tsx":
    case "src/cron/run-link.ts":
      // These modules already load on first visit; detail/editor views stay lazy.
      return "cron-page";
    case "packages/gateway-protocol/src/capability-consent-error-details.ts":
    case "packages/gateway-protocol/src/install-policy-warning-error-details.ts":
    case "packages/gateway-protocol/src/schema/plugin-declared-surface-groups.ts":
      // Shared protocol readers must not pull the lazy Plugins page into chat.
      return "plugin-contracts-runtime";
    case "ui/src/components/login-gate-solid.tsx":
    case "ui/src/components/login-gate-feedback.ts":
    case "ui/src/i18n/locales/en-login.ts":
    case "ui/src/lib/gateway-secret-shape.ts":
      return "login-runtime";
    case "ui/src/components/sidebar-update-card.tsx":
    case "ui/src/styles/sidebar-update-card.css":
      return "sidebar-update-runtime";
    case "ui/src/components/markdown-parser.ts":
    case "ui/src/components/markdown.ts":
    case "ui/src/components/github-link-target.ts":
    case "ui/src/components/markdown-assistant-transcript.ts":
    case "ui/src/components/markdown-code-blocks.ts":
    case "ui/src/components/markdown-copy.ts":
    case "ui/src/components/markdown-details.ts":
    case "ui/src/components/markdown-file-links.ts":
    case "ui/src/components/markdown-github-refs.ts":
    case "ui/src/components/markdown-human-mentions.ts":
    case "ui/src/components/markdown-icon.ts":
    case "ui/src/components/markdown-json.ts":
    case "ui/src/components/markdown-link-boundary.ts":
    case "ui/src/components/markdown-raw-content.ts":
    case "ui/src/components/markdown-render-options.ts":
    case "ui/src/components/markdown-sanitizer.ts":
    case "ui/src/components/markdown-session-links.ts":
    case "ui/src/components/markdown-streaming-state.ts":
    case "ui/src/components/markdown-tables.ts":
    case "ui/src/components/markdown-text-replacements.ts":
    case "ui/src/components/markdown-text.ts":
    case "ui/src/lib/markdown-content.ts":
    case "ui/src/i18n/locales/en-chat-media.ts":
    case "ui/src/i18n/locales/en-code-blocks.ts":
    case "ui/src/i18n/locales/en-file-preview.ts":
    case "src/shared/text/citation-control-markers.ts":
      // Parser extensions and sanitization are shared by non-Chat documents.
      return "markdown-runtime";
    case "ui/src/components/markdown-live.ts":
    case "ui/src/components/markdown-streaming.ts":
    case "ui/src/components/markdown-tokens.ts":
      return "markdown-streaming-runtime";
    case "ui/src/styles/session-panel-rail.css":
      // Keep normal rail CSS in Chat; other panels import its neutral inline text.
      return /[?&]inline(?:[=&]|$)/u.test(id) ? "deferred-ui-support" : undefined;
    case "ui/src/pages/chat/session-snapshot-database.ts":
      // Warm boot reads while the Gateway connects; the chat boot group made it wait for the whole route.
      return "session-snapshot-database";
  }

  if (
    moduleIdIncludesPackage(id, "solid-js") ||
    moduleIdIncludesPackage(id, "@solidjs/signals") ||
    moduleIdIncludesPackage(id, "@solidjs/web")
  ) {
    // Keep Solid's eager initializers out of route groups, with one compression dictionary.
    return "solid-runtime";
  }

  if (normalized.startsWith(resolvedLocaleConfigHintsModulePrefix)) {
    return `${controlUiLocaleConfigHintsChunkPrefix}${normalized.slice(resolvedLocaleConfigHintsModulePrefix.length)}`;
  }
  if (normalized.startsWith(resolvedLocaleNamespaceModulePrefix)) {
    return `locale-namespace-${normalized.slice(resolvedLocaleNamespaceModulePrefix.length).replace("/", "-")}`;
  }

  // Code highlighting is requested by the first completed code block; it must
  // not share the parser/sanitizer chunk used by ordinary transcript prose.
  if (moduleIdIncludesPackage(id, "highlight.js")) {
    return "markdown-highlight-runtime";
  }
  if (moduleIdIncludesPackage(id, "remend")) {
    return "markdown-streaming-runtime";
  }
  if (
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "markdown-it-cjk-friendly") ||
    moduleIdIncludesPackage(id, "get-east-asian-width") ||
    moduleIdIncludesPackage(id, "jsonc-parser") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    // Keep the parser closure with its lazy consumers, outside stale shared boot captures.
    return "markdown-runtime";
  }

  if (moduleIdIncludesPackage(id, "zod")) {
    return "config-runtime";
  }
  if (moduleIdIncludesPackage(id, "json5")) {
    // Config parsing loads only when a config consumer warms it.
    return "json5-runtime";
  }

  if (moduleIdIncludesPackage(id, "libphonenumber-js")) {
    return "phone-runtime";
  }

  // Keep fallback digests separate so secure contexts only download the signer.
  if (moduleIdIncludesPackage(id, "@noble/ed25519")) {
    return "device-signing-runtime";
  }

  return undefined;
}

export function createControlUiCodeSplitting(options: { includeBootGroups?: boolean } = {}) {
  return {
    includeDependenciesRecursively: false,
    groups: [
      {
        name: (id: string) => controlUiStableChunkName(id) ?? null,
        test: (id: string) => controlUiStableChunkName(id) !== undefined,
        priority: 20,
      },
      {
        name: "control-ui-core",
        test: () => true,
        tags: ["$initial"] as ["$initial"],
        priority: 10,
        // The initial graph is already eager; one dictionary avoids serial h1 requests.
        maxSize: 4096 * 1024,
      },
      ...(options.includeBootGroups === false
        ? []
        : [
            ...(["shared", "new", "chat"] as const).map((route, index) => {
              const modules = new Set(controlUiBootModules[route]);
              if (route === "shared") {
                // Plugin activation validates versions on every route without
                // evaluating Chat or adding a separate contract request.
                modules.add("src/shared/plugin-inline-view.ts");
                // Plugin contributions can initialize after the New Session boot capture.
                modules.add("ui/src/plugins/control-ui-actions.ts");
                // Both routes read deferred resources; share their existing boot partition.
                modules.add("node_modules/@solidjs/signals/dist/prod/deferred.js");
                // Chat and creation share the same identity-scoped preference owner.
                modules.add("ui/src/pages/new-session/draft-preference-state.ts");
                modules.add("ui/src/pages/new-session/preferences.ts");
                // Opened person cards share labels with New Session, not its composer chunk.
                modules.add("ui/src/lib/platform-label.ts");
                // Placement and delivery share retries without importing either route's bundle.
                modules.add("ui/src/pages/chat/chat-outbox-retry.ts");
              }
              return {
                name: `control-ui-boot-${route}`,
                test: (id: string) => modules.has(controlUiBootManifestKey(id)),
                // Shared dependencies must be assigned first, or a route group pulls
                // them (and therefore other routes) into its eagerly imported chunk.
                priority: 8 - index,
                includeDependenciesRecursively: true,
                // Keep each measured boot partition together instead of queueing
                // several fragments over HTTP/1.1. Shared and route-only code
                // retain separate groups and their existing lazy boundaries.
                minSize: (route === "chat" ? 384 : 128) * 1024,
                maxSize: (route === "shared" || route === "chat" ? 5120 : 1408) * 1024,
              };
            }),
            ...(["shared", "new", "chat"] as const).map((route) => {
              const styles = new Set(
                controlUiBootModules[route].filter((id) => id.endsWith(".css")),
              );
              if (route === "shared") {
                styles.add("ui/src/components/solid/text-overflow.css");
                // Document styles also serve Agents without loading Chat's visible renderers.
                styles.add("ui/src/styles/sidebar-markdown.css");
                styles.add("ui/src/styles/mcp-app-extensions.css");
              }
              if (route === "chat") {
                styles.delete("ui/src/components/solid/text-overflow.css");
                styles.delete("ui/src/styles/sidebar-markdown.css");
                styles.delete("ui/src/styles/mcp-app-extensions.css");
                // These optional views share the route's preloaded stylesheet.
                styles.add("ui/src/pages/chat/components/chat-pane-mobile-header.css");
                styles.add("ui/src/pages/chat/components/chat-pane-mobile-composition.css");
                styles.add("ui/src/styles/chat/context-breakdown.css");
                styles.add("ui/src/pages/chat/components/chat-session-activity.css");
              }
              return {
                name: `control-ui-boot-${route}-styles`,
                test: (id: string) =>
                  !/[?&]inline(?:[=&]|$)/u.test(id) &&
                  (styles.has(controlUiBootManifestKey(id)) ||
                    (route === "chat" && chatVisibleModules.has(controlUiBootManifestKey(id))) ||
                    (route === "shared" &&
                      controlUiBootManifestKey(id) === "ui/src/components/solid/text-overflow.ts")),
                // One stylesheet per measured route set, without per-page JS facades.
                // Keep it separate from core CSS to preserve its existing size ceiling.
                priority: 9,
              };
            }),
          ]),
    ],
  };
}

export const controlUiCodeSplitting = createControlUiCodeSplitting();

export function controlUiIsolatedDesktopRuntimePlugin(): Plugin {
  let config: ResolvedConfig;
  let runtime: Promise<string> | undefined;
  return {
    name: "control-ui-isolated-desktop-runtime",
    apply: "build",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },
    buildStart() {
      runtime = undefined;
    },
    async resolveDynamicImport(source, importer) {
      if (source !== "@novnc/novnc") {
        return null;
      }
      // noVNC awaits browser codec detection at module scope. In the main graph,
      // that disables Rolldown's facade optimization even for unrelated boot entries.
      // Bundle it unchanged and retain the desktop owner's dynamic import/await.
      runtime ??= (async () => {
        const resolved = await this.resolve(source, importer);
        if (!resolved) {
          return this.error("Cannot resolve the Control UI desktop runtime");
        }
        const result = await build({
          configFile: false,
          root: config.root,
          publicDir: false,
          logLevel: "silent",
          build: {
            write: false,
            outDir: config.build.outDir,
            minify: config.build.minify,
            target: config.build.target,
            sourcemap: config.build.sourcemap,
            rolldownOptions: {
              input: resolved.id,
              preserveEntrySignatures: "strict",
              output: {
                entryFileNames: `${config.build.assetsDir}/novnc-[hash].js`,
                strictExecutionOrder: true,
                codeSplitting: false,
              },
            },
          },
        });
        if (Array.isArray(result) || !("output" in result)) {
          return this.error("Expected one Control UI desktop runtime build");
        }
        const entry = result.output.find((output) => output.type === "chunk" && output.isEntry);
        if (!entry) {
          return this.error("Control UI desktop runtime build has no entry");
        }
        for (const output of result.output) {
          this.emitFile(
            output.type === "chunk"
              ? {
                  type: "prebuilt-chunk",
                  fileName: output.fileName,
                  code: output.code,
                  exports: output.exports,
                  map: output.map ?? undefined,
                }
              : { type: "asset", fileName: output.fileName, source: output.source },
          );
        }
        // Vite emits the desktop importer and this runtime in the same assets directory.
        return `./${path.posix.basename(entry.fileName)}`;
      })();
      return { id: await runtime, external: true };
    },
  };
}
