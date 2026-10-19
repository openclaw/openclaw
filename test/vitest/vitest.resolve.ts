import path from "node:path";
import acpCorePackageJson from "../../packages/acp-core/package.json" with { type: "json" };
import normalizationCorePackageJson from "../../packages/normalization-core/package.json" with { type: "json" };
import { pluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mts";
import privateLocalOnlyPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

const sourcePluginSdkSubpaths = [
  ...new Set([...pluginSdkSubpaths, ...privateLocalOnlyPluginSdkSubpaths]),
].toSorted((left, right) => left.localeCompare(right));

// Native fixture configs need aliases without loading the test runner plugins.
export function createVitestResolveConfig(repoRoot: string) {
  function sourcePackageAlias(packageId: string, subpath?: string) {
    return {
      find: `@openclaw/${packageId}${subpath ? `/${subpath}` : ""}`,
      replacement: path.join(
        repoRoot,
        "packages",
        packageId,
        "src",
        ...(subpath ? subpath.split("/") : ["index"]).map((part, index, parts) =>
          index === parts.length - 1 ? `${part}.ts` : part,
        ),
      ),
    };
  }

  function sourcePackageAliasesFromExports(packageId: string, exports: Record<string, unknown>) {
    return Object.keys(exports)
      .map((exportKey) => (exportKey === "." ? undefined : exportKey.slice(2)))
      .filter((subpath) => subpath === undefined || (subpath && !subpath.includes("..")))
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))
      .map((subpath) => sourcePackageAlias(packageId, subpath));
  }

  return {
    alias: [
      {
        // Route bare `zod` through a runtime shim (same pattern as the
        // discord-api-types shims below): zod's own entry re-exports `z` as a
        // namespace binding, which Bun's linker drops under Vitest's loader
        // hooks. The shim exposes the identical surface on Node and Bun.
        find: /^zod$/u,
        replacement: path.join(repoRoot, "test", "vitest", "zod-runtime.ts"),
      },
      {
        // Bypass Bun's bare-undici builtin (MockAgent is a stub) while keeping
        // package resolution relative to the importer and its installed version.
        find: /^undici$/u,
        replacement: "undici/index.js",
      },
      {
        // Keep the installed WebSocket package and its mocks on one module identity in Bun.
        find: /^ws$/u,
        replacement: path.join(repoRoot, "node_modules", "ws", "wrapper.mjs"),
      },
      {
        find: "discord-api-types/v10",
        replacement: path.join(
          repoRoot,
          "extensions",
          "discord",
          "test",
          "discord-api-types-v10-runtime.ts",
        ),
      },
      {
        find: "discord-api-types/payloads/v10",
        replacement: path.join(
          repoRoot,
          "extensions",
          "discord",
          "test",
          "discord-api-types-payloads-v10-runtime.ts",
        ),
      },
      {
        find: "@openclaw/qa-channel/api.js",
        replacement: path.join(repoRoot, "extensions", "qa-channel", "api.ts"),
      },
      {
        find: "@openclaw/discord/api.js",
        replacement: path.join(repoRoot, "extensions", "discord", "api.ts"),
      },
      {
        find: "@openclaw/matrix/test-api.js",
        replacement: path.join(repoRoot, "extensions", "matrix", "test-api.ts"),
      },
      {
        find: "@openclaw/memory-core/api.js",
        replacement: path.join(repoRoot, "extensions", "memory-core", "api.ts"),
      },
      {
        find: "@openclaw/slack/api.js",
        replacement: path.join(repoRoot, "extensions", "slack", "api.ts"),
      },
      {
        find: "@openclaw/slack/test-api.js",
        replacement: path.join(repoRoot, "extensions", "slack", "test-api.ts"),
      },
      {
        find: "@openclaw/whatsapp/api.js",
        replacement: path.join(repoRoot, "extensions", "whatsapp", "api.ts"),
      },
      {
        find: "@openclaw/gateway-client/browser",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "browser.ts"),
      },
      {
        find: "@openclaw/gateway-client/readiness",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "readiness.ts"),
      },
      {
        find: "@openclaw/gateway-client/scope-upgrade",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "scope-upgrade.ts"),
      },
      {
        find: "@openclaw/gateway-client/timeouts",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "timeouts.ts"),
      },
      {
        find: "@openclaw/gateway-client/websocket-data",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "websocket-data.ts"),
      },
      {
        find: "@openclaw/gateway-client",
        replacement: path.join(repoRoot, "packages", "gateway-client", "src", "index.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/client-info",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "client-info.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/connect-error-details",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "connect-error-details.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/frame-guards",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "frame-guards.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/gateway-error-details",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "gateway-error-details.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/restart-unavailable",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "restart-unavailable.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/schema",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "schema.ts"),
      },
      {
        find: "@openclaw/gateway-protocol/session-row-deltas",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "session-row-deltas.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/startup-unavailable",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "startup-unavailable.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/system-agent-context",
        replacement: path.join(
          repoRoot,
          "packages",
          "gateway-protocol",
          "src",
          "system-agent-context.ts",
        ),
      },
      {
        find: "@openclaw/gateway-protocol/version",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "version.ts"),
      },
      {
        find: "@openclaw/gateway-protocol",
        replacement: path.join(repoRoot, "packages", "gateway-protocol", "src", "index.ts"),
      },
      {
        find: /^@openclaw\/ai\/internal\/(.+)$/,
        replacement: path.join(repoRoot, "packages", "ai", "src", "internal", "$1.ts"),
      },
      {
        find: "@openclaw/ai/diagnostics",
        replacement: path.join(repoRoot, "packages", "ai", "src", "utils", "diagnostics.ts"),
      },
      {
        find: "@openclaw/ai/event-stream",
        replacement: path.join(repoRoot, "packages", "ai", "src", "utils", "event-stream.ts"),
      },
      {
        find: "@openclaw/ai/providers",
        replacement: path.join(repoRoot, "packages", "ai", "src", "providers.ts"),
      },
      {
        find: "@openclaw/ai/types",
        replacement: path.join(repoRoot, "packages", "ai", "src", "types.ts"),
      },
      {
        find: "@openclaw/ai/validation",
        replacement: path.join(repoRoot, "packages", "ai", "src", "validation.ts"),
      },
      {
        find: /^@openclaw\/ai\/(.+)$/,
        replacement: path.join(repoRoot, "packages", "ai", "src", "$1.ts"),
      },
      {
        find: "@openclaw/ai",
        replacement: path.join(repoRoot, "packages", "ai", "src", "index.ts"),
      },
      {
        find: "@openclaw/llm-core/diagnostics",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "utils", "diagnostics.ts"),
      },
      {
        find: "@openclaw/llm-core/event-stream",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "utils", "event-stream.ts"),
      },
      {
        find: "@openclaw/llm-core/validation",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "validation.ts"),
      },
      sourcePackageAlias("llm-core", "types"),
      sourcePackageAlias("llm-core", "model-contracts/anthropic"),
      {
        find: "@openclaw/llm-core",
        replacement: path.join(repoRoot, "packages", "llm-core", "src", "index.ts"),
      },
      {
        find: "@openclaw/model-catalog-core/configured-model-refs",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "configured-model-refs.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/model-catalog-refs",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-refs.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/model-catalog-normalize",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-normalize.ts",
        ),
      },
      sourcePackageAlias("model-catalog-core", "model-catalog-pricing"),
      {
        find: "@openclaw/model-catalog-core/model-catalog-types",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "model-catalog-types.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/provider-id",
        replacement: path.join(repoRoot, "packages", "model-catalog-core", "src", "provider-id.ts"),
      },
      {
        find: "@openclaw/model-catalog-core/provider-model-id-normalization",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "provider-model-id-normalization.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core/provider-model-id-normalize",
        replacement: path.join(
          repoRoot,
          "packages",
          "model-catalog-core",
          "src",
          "provider-model-id-normalize.ts",
        ),
      },
      {
        find: "@openclaw/model-catalog-core",
        replacement: path.join(repoRoot, "packages", "model-catalog-core", "src", "index.ts"),
      },
      {
        find: "@openclaw/net-policy/ip",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "ip.ts"),
      },
      {
        find: "@openclaw/net-policy/ipv4",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "ipv4.ts"),
      },
      {
        find: "@openclaw/net-policy/redact-sensitive-url",
        replacement: path.join(
          repoRoot,
          "packages",
          "net-policy",
          "src",
          "redact-sensitive-url.ts",
        ),
      },
      {
        find: "@openclaw/net-policy/url-protocol",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "url-protocol.ts"),
      },
      {
        find: "@openclaw/net-policy/url-userinfo",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "url-userinfo.ts"),
      },
      {
        find: "@openclaw/net-policy",
        replacement: path.join(repoRoot, "packages", "net-policy", "src", "index.ts"),
      },
      ...sourcePackageAliasesFromExports(
        "normalization-core",
        normalizationCorePackageJson.exports,
      ),
      sourcePackageAlias("markdown-core", "code-spans"),
      sourcePackageAlias("markdown-core", "fences"),
      sourcePackageAlias("media-core", "attachment-classify"),
      sourcePackageAlias("media-core", "base64"),
      sourcePackageAlias("media-core", "constants"),
      sourcePackageAlias("media-core", "content-length"),
      sourcePackageAlias("media-core", "file-name"),
      sourcePackageAlias("media-core", "inbound-path-policy"),
      sourcePackageAlias("media-core", "inline-image-data-url"),
      sourcePackageAlias("media-core", "media-source-url"),
      sourcePackageAlias("media-core", "mime"),
      sourcePackageAlias("media-core", "read-byte-stream-with-limit"),
      sourcePackageAlias("media-core"),
      sourcePackageAlias("retry"),
      sourcePackageAlias("worker-runtime", "worker"),
      sourcePackageAlias("worker-runtime", "lifecycle"),
      sourcePackageAlias("worker-runtime"),
      sourcePackageAlias("session-url-contract", "parse"),
      sourcePackageAlias("session-url-contract", "session-key-normalization"),
      sourcePackageAlias("session-url-contract", "share-build"),
      sourcePackageAlias("session-url-contract", "public-share"),
      sourcePackageAlias("session-url-contract"),
      sourcePackageAlias("workboard-contract"),
      ...sourcePackageAliasesFromExports("acp-core", acpCorePackageJson.exports),
      ...sourcePluginSdkSubpaths.map((subpath) => ({
        find: `openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`),
      })),
      ...pluginSdkSubpaths.map((subpath) => ({
        find: `@openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "packages", "plugin-sdk", "src", `${subpath}.ts`),
      })),
    ],
  };
}
