// Boundary invariant tests cover plugin boundary rules that must hold across the repo.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const sourceCache = new Map<string, string>();
const tsFilesCache = new Map<string, string[]>();
const BUNDLED_TYPED_HOOK_REGISTRATION_GUARDS = {
  "extensions/acpx/index.ts": ["reply_dispatch"],
  "extensions/active-memory/index.ts": ["agent_end", "before_prompt_build"],
  "extensions/advisor/index.ts": ["before_agent_reply"],
  "extensions/agent-guidance/index.ts": ["before_prompt_build"],
  "extensions/browser/plugin-registration.ts": ["session_end"],
  "extensions/clickclack/src/discussions/register.ts": ["before_tool_call"],
  "extensions/codex/index.ts": ["inbound_claim", "session_end"],
  "extensions/diffs/src/plugin.ts": ["before_prompt_build"],
  "extensions/discord/subagent-hooks-api.ts": ["subagent_delivery_target", "subagent_ended"],
  "extensions/facetime/index.ts": ["before_tool_call"],
  "extensions/feishu/subagent-hooks-api.ts": ["subagent_delivery_target", "subagent_ended"],
  "extensions/matrix/subagent-hooks-api.ts": ["subagent_delivery_target", "subagent_ended"],
  "extensions/mcp-events/index.ts": ["cron_changed", "cron_reconciled"],
  "extensions/memory-core/src/dreaming.ts": ["before_agent_reply", "gateway_start"],
  "extensions/memory-core/index.ts": ["before_prompt_build"],
  "extensions/memory-lancedb/index.ts": ["agent_end", "before_prompt_build", "session_end"],
  "extensions/onepassword/index.ts": ["before_tool_call"],
  "extensions/openshell/index.ts": ["before_prompt_build"],
  "extensions/qa-lab/src/gateway-registration.ts": ["before_agent_run"],
  "extensions/visitor-access/index.ts": ["gateway_start"],
  "extensions/workboard/index.ts": ["agent_end", "gateway_start", "gateway_stop", "subagent_ended"],
  "extensions/x/src/work-origin.ts": ["before_prompt_build"],
} as const satisfies Record<string, readonly string[]>;
const BUNDLED_LIVE_CONFIG_HOOK_GUARDS = {
  "extensions/active-memory/index.ts": ["resolveLivePluginConfigObject(", '"active-memory"'],
  "extensions/codex/index.ts": ["resolveLivePluginConfigObject(", '"codex"'],
  "extensions/diffs/src/plugin.ts": [
    "resolveLivePluginConfigObject(",
    '"diffs"',
    "api.runtime.config.current()",
  ],
  "extensions/memory-core/src/dreaming.ts": [
    "resolveMemoryDreamingPluginConfig(startupCfg)",
    "api.runtime.config?.current?.() ?? api.config",
  ],
  "extensions/memory-lancedb/index.ts": ["resolveLivePluginConfigObject(", '"memory-lancedb"'],
  "extensions/onepassword/index.ts": [
    "resolveLivePluginConfigObject(",
    "resolveEffectiveEnableState(",
    '"onepassword"',
    "api.runtime.config.current()",
  ],
} as const satisfies Record<string, readonly string[]>;
const BUNDLED_LIVE_CONFIG_PROVIDER_GUARDS = {
  "extensions/amazon-bedrock/register.sync.runtime.ts": [
    "resolvePluginConfigObject(",
    "const startupPluginConfig = (api.pluginConfig ?? {})",
    "const currentPluginConfig = resolveCurrentPluginConfig(ctx.config);",
    "const currentPluginConfig = resolveCurrentPluginConfig(config);",
    "const currentGuardrail = currentPluginConfig?.guardrail;",
  ],
  "extensions/amazon-bedrock-mantle/register.sync.runtime.ts": [
    "pluginConfig: resolvePluginConfigObject(ctx.config, providerId),",
  ],
  "extensions/ollama/index.ts": [
    "resolvePluginConfigObject(",
    'const runtimePluginConfig = resolvePluginConfigObject(config, "ollama");',
    "return config ? {} : startupPluginConfig;",
  ],
  "extensions/openai/index.ts": [
    "resolvePluginConfigObject(",
    'const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "openai");',
    "runtimePluginConfig ??",
    "ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>)",
  ],
} as const satisfies Record<string, readonly string[]>;
const BUNDLED_STARTUP_GATED_HOOK_FORBIDDEN_SNIPPETS = {
  "extensions/memory-lancedb/index.ts": ["if (cfg.autoRecall)", "if (cfg.autoCapture)"],
} as const satisfies Record<string, readonly string[]>;

type FileFilter = {
  excludeTests?: boolean;
  testOnly?: boolean;
};

function listTsFiles(rootRelativePath: string, filter: FileFilter = {}): string[] {
  const cacheKey = `${rootRelativePath}:${filter.excludeTests ? "exclude-tests" : ""}:${filter.testOnly ? "test-only" : ""}`;
  const cached = tsFilesCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: rootRelativePath });
  if (!files) {
    throw new Error(`failed to list tracked files for ${rootRelativePath}`);
  }
  const selected = files
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !(filter.excludeTests && file.endsWith(".test.ts")) &&
        !(filter.testOnly && !file.endsWith(".test.ts")),
    )
    .toSorted();
  tsFilesCache.set(cacheKey, selected);
  return selected;
}

function readRepoSource(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
  sourceCache.set(file, source);
  return source;
}

function isAllowedBundledExtensionImport(specifier: string): boolean {
  return /(?:^|\/)extensions\/[^/]+\/(?:api|runtime-api)\.js$/u.test(specifier);
}

function collectBundledExtensionImports(source: string): string[] {
  const sourceFile = parser.parseSourceFile("boundary-invariants-input.ts", source);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLikeNode(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && isBundledExtensionImportHelperCall(node.expression)) {
      const firstArgument = node.arguments[0];
      if (firstArgument && ts.isStringLiteralLikeNode(firstArgument)) {
        specifiers.push(firstArgument.text);
      }
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return specifiers.filter((specifier) => /(?:^|\/)extensions\/[^/]+\//u.test(specifier));
}

function isBundledExtensionImportHelperCall(expression: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ((expression.name.text === "mock" || expression.name.text === "doMock") &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "vi") ||
      expression.name.text === "importActual"
    );
  }
  return ts.isIdentifier(expression) && expression.text === "importActual";
}

function expectNoSources(
  root: string,
  filter: FileFilter,
  violates: (source: string, file: string) => boolean,
): void {
  expect(
    listTsFiles(root, filter).filter((file) => violates(readRepoSource(file), file)),
  ).toStrictEqual([]);
}

describe("plugin contract boundary invariants", () => {
  it("lists boundary invariant source files without walking roots in-process", () => {
    try {
      expectNoReaddirSyncDuring(() => {
        tsFilesCache.clear();
        const files = listTsFiles("src", { excludeTests: true });

        expect(files.length).toBeGreaterThan(0);
        expect(files.every((file) => file.startsWith("src/") && file.endsWith(".ts"))).toBe(true);
        expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
      });
    } finally {
      tsFilesCache.clear();
    }
  });

  it("keeps bundled-capability-metadata confined to contract/test inventory", () => {
    expectNoSources(
      "src",
      {},
      (source, file) =>
        file !== "src/plugins/contracts/boundary-invariants.test.ts" &&
        !file.endsWith(".contract.test.ts") &&
        !file.endsWith("-capability-metadata.test.ts") &&
        source.includes("contracts/inventory/bundled-capability-metadata"),
    );
  });

  it("keeps core tests off bundled extension deep imports", () => {
    expectNoSources(
      "src",
      { testOnly: true },
      (source) =>
        source.includes("extensions/") &&
        collectBundledExtensionImports(source).some(
          (specifier) => !isAllowedBundledExtensionImport(specifier),
        ),
    );
  });

  it("keeps plugin contract tests off bundled path helpers unless the test is explicitly about paths", () => {
    expectNoSources(
      "src/plugins/contracts",
      { testOnly: true },
      (source, file) =>
        file !== "src/plugins/contracts/boundary-invariants.test.ts" &&
        source.includes("openclaw/plugin-sdk/test-fixtures") &&
        /\b(?:BUNDLED_PLUGIN_|bundled(?:Dist)?Plugin(?:Root|File|DirPrefix)|installedPluginRoot|repoInstallSpec)\b/u.test(
          source,
        ),
    );
  });

  it("keeps channel production code off bundled-plugin-metadata helpers", () => {
    expectNoSources("src/channels", { excludeTests: true }, (source) =>
      source.includes("plugins/bundled-plugin-metadata"),
    );
  });

  it("keeps contract loaders off hand-built bundled extension paths", () => {
    const files = [
      ...listTsFiles("src/plugins", { excludeTests: true }),
      ...listTsFiles("src/channels", { excludeTests: true }),
    ].toSorted();
    const offenders = files.filter((file) =>
      /extensions\/\$\{|\.\.\/\.\.\/\.\.\/\.\.\/extensions\//u.test(readRepoSource(file)),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("keeps bundled plugin typed hook files and names on an explicit allowlist", () => {
    expect(
      Object.fromEntries(
        listTsFiles("extensions", { excludeTests: true })
          .filter((file) => /\bapi\.on\(/u.test(readRepoSource(file)))
          .map((file) => [
            file,
            [...readRepoSource(file).matchAll(/\bapi\.on\(\s*"([^"]+)"/gu)]
              .map((match) => match[1])
              .filter((hookName): hookName is string => typeof hookName === "string")
              .toSorted(),
          ]),
      ),
    ).toEqual(BUNDLED_TYPED_HOOK_REGISTRATION_GUARDS);
  });

  it("keeps bundled plugin production code off raw registerHook calls", () => {
    expectNoSources("extensions", { excludeTests: true }, (source) =>
      /\bregisterHook\(/u.test(source),
    );
  });

  it("keeps long-lived bundled hook handlers on live runtime config lookups", () => {
    expectSnippetGuards(BUNDLED_LIVE_CONFIG_HOOK_GUARDS);
  });

  it("keeps live provider config surfaces on runtime config lookups", () => {
    expectSnippetGuards(BUNDLED_LIVE_CONFIG_PROVIDER_GUARDS);
    expect(
      readRepoSource("extensions/amazon-bedrock-mantle/register.sync.runtime.ts"),
    ).not.toContain("api.pluginConfig");
  });

  it("keeps long-lived bundled hook handlers off startup-only registration gates", () => {
    expectSnippetGuards(BUNDLED_STARTUP_GATED_HOOK_FORBIDDEN_SNIPPETS, false);
  });
});

function expectSnippetGuards(guards: Record<string, readonly string[]>, required = true): void {
  const violations = Object.entries(guards).flatMap(([file, snippets]) =>
    snippets
      .filter((snippet) => readRepoSource(file).includes(snippet) !== required)
      .map((snippet) => `${file}: ${snippet}`),
  );
  expect(violations).toStrictEqual([]);
}
