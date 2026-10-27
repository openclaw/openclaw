// Builds the reusable AI package separately to keep provider bundling out of
// the already-parallel main package graph.
import type { UserConfig } from "tsdown";
import { resolveRepoRoot } from "./scripts/lib/repo-root.mjs";
import { createStandaloneSourceModuleUrlPlugin } from "./scripts/lib/standalone-source-module-urls.mjs";
import { createDeclarationBoundaryHooks } from "./scripts/lib/tsdown-declaration-boundary.mts";
import { cacheTsdownRuntimeConfigs } from "./scripts/lib/tsdown-runtime-cache.mts";

const repoRoot = resolveRepoRoot(import.meta.url);

const externalDependencies = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "@opentelemetry/api",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/semantic-conventions",
  "openai",
  "typebox",
  "zod",
  "zod-to-json-schema",
] as const;

const config = {
  clean: true,
  dts:
    process.env.OPENCLAW_RUN_NODE_SKIP_DTS_BUILD === "1"
      ? false
      : { tsconfig: "tsconfig.packages.json" },
  hooks: createDeclarationBoundaryHooks(),
  entry: {
    index: "packages/ai/src/index.ts",
    providers: "packages/ai/src/providers.ts",
    transports: "packages/ai/src/transports.ts",
    diagnostics: "packages/ai/src/utils/diagnostics.ts",
    "event-stream": "packages/ai/src/utils/event-stream.ts",
    types: "packages/ai/src/types.ts",
    "provider-types": "packages/ai/src/provider-types.ts",
    validation: "packages/ai/src/validation.ts",
    "internal/anthropic": "packages/ai/src/internal/anthropic.ts",
    "internal/google": "packages/ai/src/internal/google.ts",
    "internal/google-model-family": "packages/ai/src/internal/google-model-family.ts",
    "internal/model-request-body": "packages/ai/src/transports/model-request-body.ts",
    "internal/openai": "packages/ai/src/internal/openai.ts",
    "internal/openai-completions-compat": "packages/ai/src/internal/openai-completions-compat.ts",
    "internal/openai-responses-payload-policy":
      "packages/ai/src/internal/openai-responses-payload-policy.ts",
    "internal/retry-after": "packages/ai/src/internal/retry-after.ts",
    // Keep namespace helpers out of the deferred parser's entry chunk.
    "internal/reasoning-tag-text-partitioner":
      "packages/ai/src/utils/reasoning-tag-text-partitioner.ts",
    "internal/runtime": "packages/ai/src/internal/runtime.ts",
    "internal/shared": "packages/ai/src/internal/shared.ts",
    "internal/tool-schema": "packages/ai/src/internal/tool-schema.ts",
  },
  env: { NODE_ENV: "production" },
  format: "esm",
  outDir: "packages/ai/dist",

  copy: [{ from: "node_modules/@mistralai/mistralai/LICENSE", rename: "mistral.LICENSE" }],
  platform: "node",
  target: "node22",
  deps: {
    // Ship the chat client's reachable code, not the SDK's full API/source tree.
    alwaysBundle: [/^@mistralai\/mistralai(?:\/|$)/u],
    neverBundle(id) {
      return externalDependencies.some(
        (dependency) => id === dependency || id.startsWith(`${dependency}/`),
      );
    },
  },
} satisfies UserConfig;

export default cacheTsdownRuntimeConfigs([
  {
    ...config,
    plugins: [createStandaloneSourceModuleUrlPlugin({ rootDir: repoRoot })],
  },
])[0]!;
