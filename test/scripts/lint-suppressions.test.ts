import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectLintDisableDirectives,
  isMaxLinesRule,
} from "../../scripts/check-max-lines-ratchet.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { expectNoReaddirSyncDuring } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../src/test-utils/repo-files.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const parser = createNativeTypeScriptParser({ cwd: repoRoot });
afterAll(() => parser.close());
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([".cache", ".git", "build", "coverage", "dist", "node_modules"]);
const ROOTS = ["src", "extensions", "scripts", "ui"] as const;
// Match the generated-source exclusions in the oxlint handwritten-code ratchets.
const GENERATED_SOURCE_PATH =
  /(?:^|\/)(?:__generated__|generated|[^/]+\.generated|protocol-gen|dist)(?:\/|$)|\.generated\.[^/]+$/u;

type SuppressionEntry = {
  file: string;
  rule: string;
};

let productionCodeFilesCache: string[] | null = null;

function collectFileSuppressions(file: string, source: string): SuppressionEntry[] {
  return collectLintDisableDirectives(source, file, parser.parseSourceFile(file, source)).flatMap(
    (rules) => rules.filter((rule) => !isMaxLinesRule(rule)).map((rule) => ({ file, rule })),
  );
}

function isProductionCodeFile(relativePath: string): boolean {
  return (
    CODE_EXTENSIONS.has(path.extname(relativePath)) &&
    !GENERATED_SOURCE_PATH.test(relativePath) &&
    !path.posix.basename(relativePath).startsWith("__rootdir_boundary_canary__.") &&
    !(relativePath.includes("/test/") || /\.(?:test|spec)\.tsx?$/.test(relativePath))
  );
}

function walkCodeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return IGNORED_DIRS.has(entry.name) ? [] : walkCodeFiles(fullPath);
    }
    return [toRepoRelativePath(repoRoot, fullPath)];
  });
}

function listSuppressionFiles(): string[] {
  const result = spawnSync(
    "git",
    ["grep", "-z", "-l", "-e", "oxlint-disable", "-e", "eslint-disable", "--", ...ROOTS],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    return listProductionCodeFiles();
  }
  return result.stdout.split("\0").filter(isProductionCodeFile);
}

function listProductionCodeFiles(): string[] {
  return (productionCodeFilesCache ??= (
    listGitTrackedFiles({ repoRoot, pathspecs: ROOTS }) ??
    ROOTS.flatMap((root) => walkCodeFiles(path.join(repoRoot, root)))
  )
    .filter(isProductionCodeFile)
    .toSorted());
}

function summarizeSuppressions(entries: readonly SuppressionEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const { file, rule } of entries) {
    const key = `${file}|${rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key}|${count}`).toSorted();
}

const productionLintSuppressions = listSuppressionFiles().flatMap((file) =>
  collectFileSuppressions(file, fs.readFileSync(path.join(repoRoot, file), "utf8")),
);

describe("production lint suppressions", () => {
  it.each([
    ["ui/src/lib/protocol-validators.generated/approvals.js", false],
    ["src/schema.generated.ts", false],
    ["src/__generated__/schema.ts", false],
    ["src/generated/schema.ts", false],
    ["extensions/demo/protocol-gen/schema.ts", false],
    ["extensions/demo/dist/index.js", false],
    ["scripts/generate-schema.ts", true],
    ["ui/src/lib/protocol-validators.generated-reader.ts", true],
    ["src/agents/blobster-renderer.ts", true],
  ])("classifies handwritten suppression scope for %s", (file, handwritten) => {
    expect(isProductionCodeFile(file)).toBe(handwritten);
  });

  it.each([
    ["/* oxlint-disable\nmax-lines, no-console\n-- TODO: split this file. */", ["no-console"]],
    ["/* oxlint-disable eslint/max-lines, no-debugger */", ["no-debugger"]],
    ["/* oxlint-disable - reason */", []],
  ] as const)("keeps companion rules visible in %s", (source, rules) => {
    const file = "src/example.ts";
    expect(collectFileSuppressions(file, source)).toEqual(rules.map((rule) => ({ file, rule })));
  });

  it("lists production files from git without walking source roots", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listProductionCodeFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    });
  });

  it("keeps the intentional production suppression tail on an explicit allowlist", () => {
    expect(summarizeSuppressions(productionLintSuppressions)).toEqual(
      [
        // Indexed scans avoid per-row iterator allocations on frozen catalog snapshots.
        "extensions/anthropic/session-catalog-runtime.ts|typescript/prefer-for-of|1",
        // These callbacks run only in the page and preserve page-thrown message coercion.
        "extensions/browser/src/browser/page-function-runtime.ts|@typescript-eslint/no-base-to-string|1",
        "extensions/browser/src/browser/page-function-runtime.ts|no-eval|2",
        "extensions/browser/src/browser/pw-tools-core.activity.ts|unicorn/prefer-dom-node-text-content|1",
        "extensions/codex/session-history-worker-runtime.ts|no-warning-comments|1",
        "extensions/codex/src/app-server/run-attempt-turn-request.ts|preserve-caught-error|1",
        "extensions/diffs/src/viewer-client.ts|eslint/no-underscore-dangle|1",
        // Markdown rendering sorts fresh private arrays without copying them again.
        "extensions/discord/src/markdown.ts|unicorn/no-array-sort|2",
        "extensions/discord/src/outbound-adapter.test-harness.ts|typescript/no-unnecessary-type-parameters|1",
        // Ranking sorts private intermediate arrays; shared page order still uses a copy.
        "extensions/knowledge/src/memory-index.ts|unicorn/no-array-sort|7",
        "extensions/memory-core/src/memory/hybrid.ts|unicorn/no-array-sort|2",
        "extensions/memory-core/src/memory/manager-embedding-ops.ts|unicorn/no-array-fill-with-reference-type|1",
        "extensions/nostr/src/nostr-profile-url-safety.ts|no-warning-comments|1",
        "extensions/qa-lab/src/gateway-child-setup.ts|preserve-caught-error|1",
        // Chronological history reverses only fresh slice results, preserving API response arrays.
        "extensions/slack/src/monitor/message-handler/prepare-dm-history.ts|unicorn/no-array-reverse|1",
        "extensions/slack/src/monitor/provider-support.ts|typescript/no-unnecessary-type-parameters|1",
        "extensions/slack/src/monitor/thread.ts|unicorn/no-array-reverse|1",
        // The renderer sorts only fresh Set-spread/filter arrays, preserving caller-owned entities.
        "extensions/telegram/src/bot/inbound-text-entities.ts|unicorn/no-array-sort|3",
        // Thread assembly orders fresh Map-spread arrays without mutating posts or caller inputs.
        "extensions/x/src/thread.ts|unicorn/no-array-reverse|1",
        "extensions/x/src/thread.ts|unicorn/no-array-sort|2",
        // The memory census attributes RSS only to the pinned Playwright browser's child tree.
        "scripts/bench-control-ui-engines.ts|no-underscore-dangle|1",
        // The Talk readiness probe calls the saved media method with its original receiver.
        "scripts/bench-control-ui-talk.ts|typescript/unbound-method|1",
        // The fault observer preserves methods for restoration and supplies each database receiver through .call.
        "scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs|typescript/unbound-method|2",
        "scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs|no-underscore-dangle|1",
        "scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs|preserve-caught-error|1",
        "scripts/e2e/parallels/host-command.ts|no-warning-comments|1",
        // Pinned Playwright exposes WebKit Inspector only through its private connection/session fields.
        "scripts/lib/control-ui-engine-memory.ts|no-underscore-dangle|3",
        "scripts/lib/control-ui-engine-metrics.ts|no-underscore-dangle|3",
        // The streaming probe forwards native methods with their original receivers.
        "scripts/lib/control-ui-engine-streaming-scenarios.ts|typescript/unbound-method|2",
        // The scheduling probe forwards native methods with the original call receiver through Reflect.apply.
        "scripts/lib/control-ui-resource-counts.ts|typescript/unbound-method|8",
        // The Talk probe forwards native playback, analyser, processor, start, and stop methods with their original receivers.
        "scripts/lib/control-ui-talk-fixture.ts|typescript/unbound-method|5",
        "scripts/lib/plain-gh.mjs|no-warning-comments|1",
        "scripts/lib/sqlite-reliability-process.ts|typescript/prefer-promise-reject-errors|1",
        // The frame census retains native methods and supplies their original receivers through .call.
        "scripts/perf/agent-event-frame-census-preload.mjs|typescript/unbound-method|3",
        // The copy-count probe restores the native method after measurement.
        "scripts/perf/agent-fresh-array-copy-measure.ts|no-extend-native|2",
        // The owner probe executes its selected trusted source expression rather than a copied implementation.
        "scripts/perf/attempt-prompt-context-measure.ts|typescript/no-implied-eval|1",
        "scripts/perf/attempt-stream-options-measure.ts|typescript/no-implied-eval|1",
        // The avatar dispatch probe forwards the original pool receiver and restores the method.
        "scripts/perf/avatar-inline-measure.ts|typescript/unbound-method|1",
        // The load probe forwards native WebSocket.send with its original socket receiver.
        "scripts/perf/catalog-polling-measure.ts|typescript/unbound-method|1",
        // The retention probe preserves the static Buffer factories for exact restoration.
        "scripts/perf/command-capture-pool-retention.ts|typescript/unbound-method|2",
        // The diagnostics probe restores Session.post and invokes it with its live receiver.
        "scripts/perf/diagnostic-profile-measure.ts|typescript/unbound-method|1",
        // Node BroadcastChannel.postMessage has no target-origin parameter.
        "scripts/perf/idle-gateway-measure-preload.mjs|unicorn/require-post-message-target-origin|1",
        // The stack probe compares V8's formatter callback identity without invoking it.
        "scripts/perf/jiti-stack-format.ts|typescript/unbound-method|1",
        "scripts/perf/lease-main-thread-renewal.mjs|typescript/unbound-method|3",
        // The counts-only probe restores the native copying sort in finally.
        "scripts/perf/memory-prompt-copy-measure.ts|no-extend-native|2",
        // Keep measured fixture shapes unchanged; construction is outside the benchmark loop.
        "scripts/perf/memory-ranking-copies.ts|oxc/no-map-spread|2",
        // The size-record probe forwards Map.set with the original map receiver.
        "scripts/perf/model-prompt-stats-measure.ts|typescript/unbound-method|1",
        // The footprint observer supplies the native MessagePort receiver through Reflect.apply.
        "scripts/perf/pg-footprint-preload.mjs|typescript/unbound-method|1",
        // Node BroadcastChannel.postMessage has no target-origin parameter.
        "scripts/perf/pg-footprint-preload.mjs|unicorn/require-post-message-target-origin|1",
        // The fault injector supplies the native pg.Client receiver through Reflect.apply.
        "scripts/perf/pg-pool-hang.worker.mjs|typescript/unbound-method|1",
        // The require tracer forwards the original method with each requesting module as receiver.
        "scripts/perf/plugin-transform-preload.mjs|typescript/unbound-method|1",
        // The provider probe forwards native methods with their original receivers.
        "scripts/perf/provider-request-prepare-measure.ts|typescript/unbound-method|3",
        // Native transaction timing forwards the live receiver and restores the original method.
        "scripts/perf/session-cold-selection.ts|typescript/unbound-method|1",
        // Node worker ports have no browser target origin.
        "scripts/perf/session-entry-patch-payload.ts|unicorn/require-post-message-target-origin|1",
        // The setup probe executes an expression from the same trusted source input it imports.
        "scripts/perf/session-history-reader-setup-measure.mjs|typescript/no-implied-eval|1",
        // The subscription probe forwards track with the original AsyncWorkScope receiver.
        "scripts/perf/session-pr-subscriptions-measure.ts|typescript/unbound-method|1",
        // The registry-copy probe forwards Map.set with the original map receiver.
        "scripts/perf/subagent-maintenance-capture-measure.ts|typescript/unbound-method|1",
        // The retention probe measures fresh strings from the transcript JSON decode boundary.
        "scripts/perf/system-prompt-pool-retention.ts|unicorn/prefer-structured-clone|1",
        // The counts-only probe wraps toSorted and restores it in finally; timing uses native methods.
        "scripts/perf/tools-catalog-copy-measure.ts|no-extend-native|2",
        // The browser probe forwards IndexedDB writes with each store receiver and restores both methods.
        "scripts/perf/ui-streaming-render-measure.ts|typescript/unbound-method|2",
        // These owners sort only fresh private arrays, preserving their source collections.
        "src/agents/agent-bundle-lsp-env.ts|unicorn/no-array-sort|1",
        "src/agents/agent-bundle-mcp-runtime.ts|unicorn/prefer-add-event-listener|1",
        "src/agents/agent-tools.abort.ts|typescript/prefer-promise-reject-errors|1",
        "src/agents/auth-profiles/external-cli-scope.ts|unicorn/no-array-sort|2",
        "src/agents/auth-profiles/oauth-refresh-fence.ts|preserve-caught-error|1",
        "src/agents/auth-profiles/oauth-refresh-peers.ts|preserve-caught-error|1",
        "src/agents/code-mode-mcp-api.ts|unicorn/no-array-sort|1",
        "src/agents/computer-use-node-capabilities.ts|unicorn/no-array-sort|1",
        // Sort only freshly materialized private arrays; avoid a second copying sort.
        "src/agents/embedded-agent-runner/model.static-catalog.ts|unicorn/no-array-sort|2",
        "src/agents/embedded-agent-runner/post-compaction-loop-guard.ts|unicorn/no-array-sort|1",
        "src/agents/embedded-agent-runner/run/attempt-context-summary.ts|unicorn/no-array-sort|1",
        "src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts|unicorn/no-array-sort|2",
        // Stream wrappers preserve the original source iterator's rejection value.
        "src/agents/embedded-agent-runner/run/stream-wrapper.ts|typescript/prefer-promise-reject-errors|1",
        "src/agents/embedded-agent-runner/session-prompt-state.ts|unicorn/no-array-sort|1",
        "src/agents/embedded-agent-runner/tool-name-allowlist.ts|unicorn/no-array-sort|1",
        "src/agents/harness-runtimes.ts|unicorn/no-array-sort|1",
        "src/agents/mcp-http-transport.ts|unicorn/prefer-add-event-listener|3",
        "src/agents/prepared-model-runtime.synthetic-auth.ts|unicorn/no-array-sort|1",
        "src/agents/session-dirs.ts|unicorn/no-array-sort|1",
        "src/agents/tool-schema-hints.ts|unicorn/no-array-sort|1",
        // Media list snapshots must honor the JSON serialization contract; structuredClone cannot materialize plugin-bound proxies.
        "src/agents/tools/media-generate-tool-actions-shared.ts|unicorn/prefer-structured-clone|1",
        // Board private helpers only sort cloned layouts or freshly filtered arrays.
        "src/boards/board-layout.ts|unicorn/no-array-sort|1",
        "src/channels/plugins/channel-runtime-surface.types.ts|typescript/no-unnecessary-type-parameters|1",
        "src/channels/plugins/config-schema.ts|typescript/no-generated-empty-object-type|1",
        "src/channels/plugins/contracts/test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        // Account defaults and heterogeneous registries erase plugin-specific callback families;
        // unknown rejects concrete account/probe/audit callbacks. Gateway versions remain checked.
        "src/channels/plugins/types.plugin.ts|typescript/no-explicit-any|2",
        "src/cli/cli-utils.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/command-options.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/plugins-cli-test-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        "src/cli/program/openclaw-command.ts|eslint/no-underscore-dangle|1",
        "src/cli/test-runtime-capture.ts|typescript/no-unnecessary-type-parameters|1",
        // Both restore cleanup paths retain the primary and cleanup failures in AggregateError.errors.
        "src/commands/backup-restore.ts|preserve-caught-error|2",
        // Sort only freshly materialized private arrays, preserving source order and ownership.
        "src/config/channel-config-activation.ts|unicorn/no-array-sort|1",
        // Active-tail readers reorder only their fresh private selection and visitor arrays.
        "src/config/sessions/session-accessor.sqlite-active-events-read.ts|unicorn/no-array-sort|1",
        "src/config/sessions/session-accessor.sqlite-active-events.ts|unicorn/no-array-reverse|1",
        "src/config/sessions/session-accessor.sqlite-schema-probes.test-support.ts|typescript/unbound-method|2",
        "src/config/sessions/session-accessor.sqlite-worker-request.ts|no-warning-comments|1",
        "src/config/sessions/session-transcript-reconcile.close-failure.test-support.mjs|typescript/unbound-method|1",
        "src/config/sessions/session-transcript-reconcile.sql-observer.test-support.ts|typescript/unbound-method|1",
        // Canonical entries must honor toJSON and omit non-JSON values exactly as persistence does.
        "src/config/sessions/transcript-json.ts|unicorn/prefer-structured-clone|1",
        "src/config/zod-schema.channel-messaging-common.ts|typescript/no-generated-empty-object-type|1",
        // Command declarations compare their stored JSON shape, where undefined properties are omitted.
        "src/cron/store/job-mutations.ts|unicorn/prefer-structured-clone|1",
        // These sort only freshly materialized arrays or locally owned swarm member lists.
        "src/gateway/health/collector.ts|unicorn/no-array-sort|3",
        "src/gateway/methods/read-share-keys.ts|unicorn/no-array-sort|1",
        "src/gateway/node-connection-notifications.ts|unicorn/no-array-sort|1",
        "src/gateway/node-plugin-tool-snapshot.ts|unicorn/no-array-sort|1",
        // These handlers sort only fresh private arrays, preserving their upstream sources.
        "src/gateway/server-methods/sessions-files.ts|unicorn/no-array-sort|1",
        "src/gateway/server-methods/sessions-read.ts|unicorn/no-array-sort|1",
        "src/gateway/server-methods/sessions-search-projected.ts|unicorn/no-array-sort|1",
        "src/gateway/server-methods/tools-catalog.ts|unicorn/no-array-sort|1",
        "src/gateway/server-methods/usage-session-loading.ts|unicorn/no-array-sort|1",
        // Pinned Bun HTTP sockets omit Writable._writev; this probe selects native or one-copy batching.
        "src/gateway/server/ws-transport.ts|no-underscore-dangle|1",
        "src/gateway/session-companion-prompt.ts|unicorn/no-array-sort|1",
        // Preserve the measured indexed fanout loop while reusing envelope tuples.
        "src/gateway/session-event-projection.ts|typescript/prefer-for-of|1",
        // Event field ordering sorts only the freshly filtered, audience-private key array.
        "src/gateway/session-event-projection.ts|unicorn/no-array-sort|1",
        // Sharing keys sort the private alias spread without copying it a second time.
        "src/gateway/session-sharing-read.ts|unicorn/no-array-sort|1",
        "src/gateway/session-swarm-summary.ts|unicorn/no-array-sort|2",
        // Node worker ports do not accept a browser target origin.
        "src/gateway/system-ca-warmup.worker.ts|unicorn/require-post-message-target-origin|1",
        "src/hooks/module-loader.ts|typescript/no-unnecessary-type-parameters|1",
        "src/infra/device-pairing-row-mapping.ts|typescript/no-unnecessary-type-parameters|1",
        "src/infra/json-file.ts|typescript-eslint/no-unnecessary-type-parameters|1",
        "src/infra/net/fetch-guard.ts|no-warning-comments|1",
        "src/infra/net/undici-dispatcher-options.ts|typescript/unbound-method|1",
        "src/infra/outbound/sanitize-text.ts|eslint/no-control-regex|1",
        "src/infra/outbound/send-deps.ts|typescript/no-unnecessary-type-parameters|1",
        // Node BroadcastChannel.postMessage has no target-origin parameter.
        "src/infra/postgres-sync/pool.ts|unicorn/require-post-message-target-origin|1",
        "src/infra/sqlite-database-admission.worker.test-support.ts|typescript/unbound-method|1",
        "src/infra/sqlite-native-observer.ts|typescript/unbound-method|2",
        "src/infra/sqlite-worker-input.bun.test-support.ts|typescript/unbound-method|1",
        "src/infra/sqlite-worker-shared-state-admission.test-support.ts|typescript/unbound-method|1",
        "src/infra/system-presence.ts|unicorn/no-array-sort|2",
        "src/infra/worker-cpu.ts|typescript/unbound-method|4",
        // MCP owns callback properties; Node worker messages have no browser target origin.
        "src/mcp/tools-stdio-server.lifecycle.fixture.mjs|unicorn/prefer-add-event-listener|1",
        "src/mcp/tools-stdio-server.lifecycle.fixture.mjs|unicorn/require-post-message-target-origin|1",
        // Media selection reorders only fresh filter/flatMap results, preserving caller arrays.
        "src/media-understanding/attachments.select.ts|unicorn/no-array-reverse|1",
        "src/media-understanding/provider-registry-metadata.ts|unicorn/no-array-sort|1",
        "src/node-host/invoke-payload.ts|typescript/no-unnecessary-type-parameters|1",
        "src/node-host/mcp.ts|unicorn/prefer-add-event-listener|1",
        "src/plugin-sdk/channel-config-helpers.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/channel-entry-contract.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/facade-loader.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/facade-runtime.ts|typescript/no-unnecessary-type-parameters|3",
        "src/plugin-sdk/json-store.ts|typescript-eslint/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/qa-runner-runtime.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugin-sdk/test-helpers/subagent-hooks.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/host-hooks.ts|typescript/no-unnecessary-type-parameters|1",
        "src/plugins/installed-plugin-index-policy.ts|unicorn/no-array-sort|2",
        // Compiler scope saves/restores V8's formatter callback by identity without calling it.
        "src/plugins/jiti-factory.ts|typescript/unbound-method|1",
        "src/plugins/lazy-service-module.ts|typescript/no-unnecessary-type-parameters|1",
        // Prompt preparation sorts only fresh private tool and supplement arrays.
        "src/plugins/memory-state.ts|unicorn/no-array-sort|2",
        // Reflect.apply supplies the wrapped callable as Function.prototype.bind's receiver.
        "src/plugins/plugin-instance-bindings.ts|typescript/unbound-method|1",
        // Iterator continuations supply the native Promise receiver and preserve exact plugin rejection values.
        "src/plugins/plugin-instance-iterator.ts|typescript/prefer-promise-reject-errors|1",
        "src/plugins/plugin-instance-iterator.ts|typescript/unbound-method|1",
        "src/plugins/plugin-instance-owned-values.ts|eslint/no-constructor-return|1",
        "src/plugins/plugin-instance-owned-values.ts|typescript/no-extraneous-class|1",
        "src/plugins/plugin-return-value.ts|typescript/prefer-promise-reject-errors|1",
        "src/plugins/plugin-return-value.ts|typescript/unbound-method|1",
        "src/plugins/plugin-return-value.ts|unicorn/no-thenable|1",
        "src/plugins/provider-login-options.ts|unicorn/no-array-sort|2",
        "src/plugins/provider-registry-selection.ts|unicorn/no-array-sort|1",
        "src/plugins/public-surface-loader.ts|typescript/no-unnecessary-type-parameters|3",
        "src/plugins/registry-registrars-providers.ts|typescript/unbound-method|1",
        // Admission records original factory identities; executable views bind their receivers.
        "src/plugins/registry-registrars.ts|typescript/unbound-method|1",
        "src/plugins/runtime/runtime-plugin-boundary.ts|typescript/no-unnecessary-type-parameters|1",
        // Indexed adoption scans avoid per-row iterator allocation on frozen catalog snapshots.
        "src/plugins/session-catalog.ts|typescript/prefer-for-of|1",
        "src/plugins/trusted-tool-policy.ts|typescript/no-unnecessary-type-parameters|1",
        // Basic credentials must reject C0 controls and DEL before sentinel substitution.
        "src/secrets/egress-proxy/proxy-server.ts|no-control-regex|1",
        "src/secrets/egress-proxy/proxy-server.ts|no-warning-comments|1",
        "src/secrets/private-plan-file.ts|preserve-caught-error|1",
        "src/sessions/session-lifecycle-identity.ts|unicorn/no-array-sort|1",
        // Synchronous acquisition failures reject with the acquiring owner's original value.
        "src/shared/store-writer-acquisitions.ts|typescript/prefer-promise-reject-errors|1",
        // Usage outputs sort freshly materialized private arrays without another copy.
        "src/shared/usage-aggregates.ts|unicorn/no-array-sort|1",
        "src/shared/usage-overview.ts|unicorn/no-array-sort|5",
        "src/skills/loading/skill-precedence.ts|unicorn/no-array-sort|3",
        "src/state/config-machine-state.ts|typescript/no-unnecessary-type-parameters|1",
        // JSON string scanning must detect and reject unescaped control characters.
        "src/state/json-predicate-fields.ts|no-control-regex|1",
        "src/state/openclaw-agent-canonical-validation-receipt.test-support.ts|typescript/unbound-method|1",
        // Node worker BroadcastChannel.postMessage accepts only a message, not a browser targetOrigin.
        "src/state/openclaw-agent-worker-store.test-support.ts|unicorn/require-post-message-target-origin|1",
        "src/status/status-plugin-health.ts|unicorn/no-array-sort|6",
        "src/test-utils/config-machine-state.ts|typescript/no-unnecessary-type-parameters|1",
        "src/test-utils/vitest-mock-fn.ts|typescript/no-explicit-any|1",
        // The query observer invokes the captured native method with the intercepted database receiver.
        "src/transcripts/library.query-budget.test-support.ts|typescript/unbound-method|1",
        "src/utils.ts|typescript/no-unnecessary-type-parameters|1",
        "src/utils/run-with-concurrency.ts|typescript/prefer-promise-reject-errors|1",
        // Native host bridges are not EventTargets or Window.postMessage endpoints.
        "ui/src/app/native-bridge.ts|unicorn/require-post-message-target-origin|1",
        "ui/src/app/native-gateway-auth.ts|unicorn/prefer-add-event-listener|1",
        "ui/src/app/native-gateway-auth.ts|unicorn/require-post-message-target-origin|2",
        "ui/src/components/mascot-canvas.ts|unicorn/no-array-fill-with-reference-type|1",
        // A bridge renderer keeps the same native host for its complete lifetime.
        "ui/src/components/session-background.tsx|solid/reactivity|1",
        "ui/src/components/session-progress-card.test-support.tsx|no-underscore-dangle|2",
        // These Solid sinks consume HTML sanitized or escaped by their content owners.
        "ui/src/components/solid/markdown-html.tsx|solid/no-innerhtml|1",
        "ui/src/components/solid/sanitized-html.tsx|solid/no-innerhtml|1",
        // PanelRefreshStatus keeps its shared className prop across rendering callers.
        "ui/src/pages/custodian/custodian-surface.tsx|solid/no-react-specific-props|1",
        "ui/src/pages/logs/view.tsx|solid/no-react-specific-props|1",
        // Session commands relay the owner's original error so the display boundary can format it.
        "ui/src/pages/sessions/view.tsx|typescript/only-throw-error|1",
      ].filter((entry) => fs.existsSync(path.join(repoRoot, entry.split("|", 1)[0]!))),
    );
  });
});
