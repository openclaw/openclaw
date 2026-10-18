import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import type { AssistantMessage } from "@openclaw/ai";
import { execa } from "execa";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertControlUiGeneratedArtifactsIsolated,
  resolveAllowedGeneratedMixBranch as allowedBranch,
  shouldStrictControlUiI18n,
} from "../../scripts/ci-changed-scope.mjs";
import {
  analyzeControlUiCatalogs,
  flattenControlUiCatalog as flattenCatalog,
  formatControlUiCatalogFallbackDriftError,
  verifyControlUiReferencedKeys as verifyKeys,
} from "../../scripts/control-ui-i18n-verify.ts";
import {
  assertNoControlUiFallbacks,
  buildBatchPrompt,
  filterPlaceholderCompatibleTranslations,
  parseTranslationBatchReply,
  translateNativeEntries,
} from "../../scripts/control-ui-i18n.ts";
import {
  loadControlUiSourceCatalog,
  readControlUiSourceCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog.ts";
import { collectControlUiRawCopyFromSource } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { makeAgentAssistantMessage } from "../../src/agents/test-helpers/agent-message-fixtures.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { configHintTranslationKey } from "../../ui/src/i18n/lib/config-hint-translation.ts";
import { registerCodeBlocksEnglish } from "../../ui/src/i18n/locales/en-code-blocks.ts";
import { registerLabsEnglish } from "../../ui/src/i18n/locales/en-labs.ts";
import { registerSettingsEnglish } from "../../ui/src/i18n/locales/en-settings.ts";
import { registerTranscriptsEnglish } from "../../ui/src/i18n/locales/en-transcripts.ts";
import { createTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/lib/sleep.mjs", () => ({ sleep: async () => {} }));
const testNodeExecPath = resolveTestNodeExecPath();
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const llm = vi.hoisted(() => ({ completeSimple: vi.fn() }));
const strings = (values: Record<string, string>) => new Map(Object.entries(values));
const childOptions = { reject: false, timeout: 120_000, stripFinalNewline: false } as const;
const tsxArgs = ["--import", "./scripts/tsx.mjs"];
vi.mock("@openclaw/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/ai")>();
  return {
    ...actual,
    createLlmRuntime: () => ({ ...actual.createLlmRuntime(), completeSimple: llm.completeSimple }),
  };
});

describe("translation provider privacy and fallback", () => {
  const primary = "private-primary-fixture";
  const fallback = "private-fallback-fixture";
  const entries = Array.from({ length: 21 }, (_, index) => ({
    id: `label${index}`,
    source: "Open",
    sourcePath: "fixture.ts",
  }));
  const response = (overrides: Partial<AssistantMessage> = {}): AssistantMessage =>
    makeAgentAssistantMessage({
      content: [{ type: "text", text: translatedReply }],
      model: primary,
      ...overrides,
    });
  const translatedReply = JSON.stringify(
    Object.fromEntries(entries.map(({ id }) => [id, "Ouvrir"])),
  );
  const providerError = (errorCode: string, errorMessage: string) =>
    response({ stopReason: "error", errorCode, errorMessage });
  const translate = (items = entries) => translateNativeEntries(items, "fr");
  const expectFailure = (message = "provider_error") =>
    expect(translate(entries.slice(0, 1))).rejects.toThrow(message);
  const output = () => vi.mocked(process.stdout).write.mock.calls.flat().join("");
  const expectPrivate = () => {
    expect(output()).not.toContain(primary);
    expect(output()).not.toContain(fallback);
  };
  beforeEach(() => {
    llm.completeSimple.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_PROVIDER", "openai");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_MODEL", primary);
    vi.stubEnv("OPENCLAW_I18N_FALLBACK_MODEL", fallback);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reports CLI failures without disclosing configured model or key values", async () => {
    const result = await execa(
      process.execPath,
      [
        ...tsxArgs,
        "scripts/control-ui-i18n.ts",
        "sync",
        "--locale",
        `${primary.toUpperCase()}/${fallback}/test-key`,
      ],
      childOptions,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("unknown locale: [redacted]/[redacted]/[redacted]");
  });

  it.each([
    { args: ["sync", "--refresh-key"], error: "requires a catalog key" },
    {
      args: ["sync", "--locale", "pl", "--refresh-key", "chat.parentSession"],
      error: "requires sync --write --locale",
    },
    {
      args: ["sync", "--write", "--refresh-key", "chat.parentSession"],
      error: "requires sync --write --locale",
    },
    {
      args: ["check", "--locale", "pl", "--refresh-key", "chat.parentSession"],
      error: "requires sync --write --locale",
    },
    {
      args: ["sync", "--write", "--locale", "pl", "--force", "--refresh-key", "chat.parentSession"],
      error: "cannot be combined with --force",
    },
    {
      args: [
        "sync",
        "--write",
        "--locale",
        "pl",
        ...Array.from({ length: 65 }, (_, i) => ["--refresh-key", `key${i}`]).flat(),
      ],
      error: "at most 64 distinct keys",
    },
    {
      args: ["sync", "--write", "--locale", "pl", "--refresh-key", "missing.fixture.key"],
      error: "unknown refresh key: missing.fixture.key",
    },
  ])("rejects invalid targeted refresh: $error", async ({ args, error }) => {
    const result = await execa(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/control-ui-i18n.ts", ...args],
      { reject: false, timeout: 120_000, stripFinalNewline: false },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
  });

  it("requires provider authentication for targeted refresh even when auth is optional", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_AUTH_OPTIONAL", "1");
    const result = await execa(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/control-ui-i18n.ts",
        "sync",
        "--write",
        "--locale",
        "pl",
        "--refresh-key",
        "chat.parentSession",
      ],
      { reject: false, timeout: 120_000, stripFinalNewline: false },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--refresh-key requires a configured translation provider");
  });

  it("translates native artifacts without Gateway state or Control UI catalogs", async () => {
    const temp = createTempDirTracker();
    const stateDir = path.join(temp.make("openclaw-translation-runtime-"), "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const scriptUrl = pathToFileURL(path.resolve("scripts/native-app-i18n.ts")).href;
      const uiOnlyModules = [
        "scripts/lib/control-ui-i18n-catalog.ts",
        "scripts/control-ui-i18n-verify.ts",
        "scripts/lib/control-ui-i18n-raw-copy.ts",
      ].map((file) => pathToFileURL(path.resolve(file)).href);
      const translationsDir = path.join(path.dirname(stateDir), "translations");
      const code = `
        import assert from "node:assert/strict";
        import { readFile } from "node:fs/promises";
        import net from "node:net";
        import { registerHooks, syncBuiltinESMExports } from "node:module";
        const uiOnlyModules = new Set(${JSON.stringify(uiOnlyModules)});
        registerHooks({
          resolve(specifier, context, nextResolve) {
            const resolved = nextResolve(specifier, context);
            assert.ok(!uiOnlyModules.has(resolved.url), "Native translation loaded a Control UI catalog owner: " + resolved.url);
            return resolved;
          },
        });
        const rejectNetwork = () => { throw new Error("Unexpected network connection"); };
        net.connect = net.createConnection = net.Socket.prototype.connect = rejectNetwork;
        syncBuiltinESMExports();
        let requests = 0;
        globalThis.fetch = async (input, init) => {
          requests += 1;
          const request = new Request(input, init);
          const payload = await request.json();
          assert.ok(JSON.stringify(payload.input).includes("apps/android/wear/src/main/res/values/strings.xml"), "native owner context must reach the serialized provider request");
          assert.ok(JSON.stringify(payload.input).includes("VoiceGestureLabel(onHold: startDictate)"), "native owner excerpt must reach the serialized provider request");
          assert.ok(JSON.stringify(payload.input).includes("unnumbered printf"), "native formatting must retain source argument roles");
          assert.ok(JSON.stringify(payload).includes("Connect -> Connecter"), "native glossary must reach the provider request");
          const item = { id: "message", type: "message", role: "assistant", content: [] };
          const text = JSON.stringify({ "native.android.0123456789abcdef": "Connecter {count}" });
          const events = [
            { type: "response.created", response: { id: "response" } },
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
            { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text, annotations: [] }] } },
            { type: "response.completed", response: { id: "response", status: "completed" } },
          ];
          return new Response(events.map(event => "data: " + JSON.stringify(event) + "\\n\\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
        };
        const { syncNativeLocale } = await import(${JSON.stringify(scriptUrl)});
        const result = await syncNativeLocale("fr", [{ id: "native.android.0123456789abcdef", source: "Connect {count}", surface: "android", sites: [{ kind: "fixture", path: "apps/android/wear/src/main/res/values/strings.xml" }], sourceContext: "VoiceGestureLabel(onHold: startDictate)" }], { glossary: [{ source: "Connect", target: "Connecter" }], translationsDir: ${JSON.stringify(translationsDir)} });
        const artifact = JSON.parse(await readFile(${JSON.stringify(path.join(translationsDir, "fr.json"))}, "utf8"));
        assert.equal(artifact.translations["native.android.0123456789abcdef"], "Connecter {count}");
        assert.equal(result.translated, 1);
        assert.equal(requests, 1);
        console.log("isolated-runtime-ok");
      `;
      const result = await execa(
        testNodeExecPath,
        [...tsxArgs, "--input-type=module", "-e", code],
        childOptions,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("isolated-runtime-ok");
      expect(result.stdout + result.stderr).not.toContain(primary);
      expect(result.stdout + result.stderr).not.toContain("[model-fetch]");
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      temp.cleanup();
    }
  });

  it("switches only an unavailable model and keeps the fallback for later batches", async () => {
    const complete = llm.completeSimple
      .mockResolvedValueOnce(providerError("model_not_found", `Cannot use ${primary}`))
      .mockResolvedValue(response());
    expect((await translate()).size).toBe(entries.length);
    expect(complete.mock.calls.map(([model]) => model.id)).toEqual([primary, fallback, fallback]);
    expect(output()).toContain("primary model unavailable");
    expectPrivate();
  });

  it("does not let a timed-out batch switch models after its split replacements complete", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_PROMPT_TIMEOUT", "50");
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_BATCH_CHAR_BUDGET", "2000");
    const late = Promise.withResolvers<AssistantMessage>();
    llm.completeSimple.mockReturnValueOnce(late.promise).mockResolvedValue(response());
    try {
      const translated = translate(entries.slice(0, 2));
      await vi.advanceTimersByTimeAsync(50);
      expect((await translated).size).toBe(2);
      expect(llm.completeSimple.mock.calls[0]?.[2].signal.aborted).toBe(true);

      late.resolve(providerError("model_not_found", primary));
      await vi.runAllTimersAsync();
      expect(llm.completeSimple.mock.calls.map(([model]) => model.id)).toEqual([
        primary,
        primary,
        primary,
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes native owner context in the translation batch budget", async () => {
    vi.stubEnv("OPENCLAW_CONTROL_UI_I18N_BATCH_CHAR_BUDGET", "500");
    llm.completeSimple.mockResolvedValue(response());
    const contextualEntries = entries.slice(0, 2).map((entry) => ({
      id: entry.id,
      source: entry.source,
      sourcePath: "apps/android/app/src/main/java/ai/openclaw/app/ui/CronJobManagementPanel.kt",
      sourceContext: "Button(enabled = !runPending) ".repeat(6),
    }));

    expect((await translate(contextualEntries)).size).toBe(2);
    expect(llm.completeSimple).toHaveBeenCalledTimes(2);
  });

  it.each(["401", "404"])("keeps %s failures private without switching", async (errorCode) => {
    const complete = llm.completeSimple.mockResolvedValue(
      providerError(errorCode, `${errorCode}: ${primary} unavailable; try ${fallback}`),
    );
    await expectFailure("translation provider failed");
    expect(complete.mock.calls.every(([model]) => model.id === primary)).toBe(true);
    expectPrivate();
  });

  it("does not expose rejected provider errors or escaped model echoes", async () => {
    const complete = llm.completeSimple.mockRejectedValue(new Error(`Transport for ${primary}`));
    await expectFailure();
    complete.mockResolvedValue(
      response({ content: [{ type: "text", text: '{"label0":"private-\\u0070rimary-fixture"}' }] }),
    );
    await expectFailure();
    expect(output()).not.toContain(primary);
  });
});

describe("control-ui config hint source catalog", () => {
  it("includes plugin-owned Memory label sources in the raw catalog hash input", async () => {
    const source = await readControlUiSourceCatalog();
    for (const plugin of ["active-memory", "memory-wiki"]) {
      expect(source).toContain(
        readFileSync(`extensions/${plugin}/control-ui.presentation.json`, "utf8"),
      );
    }
  });

  it("includes core config labels and help under collision-safe keys", () => {
    const source = flattenTranslations(loadControlUiSourceCatalog());

    const label = "Gateway Token";
    expect(source.get(configHintTranslationKey("gateway.auth.token", "label", label))).toBe(label);
    const helpEntry = [...source].find(([key]) =>
      key.startsWith("configHints.gateway%2Eauth%2Etoken.help."),
    );
    expect(helpEntry?.[1]).toBeTypeOf("string");
  });
});

describe("control-ui-i18n generated ownership", () => {
  it("includes lazy page copy and shared search labels in the generator catalog", () => {
    const result = spawnSync(
      testNodeExecPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "--eval",
        [
          'import { loadControlUiSourceCatalog } from "./scripts/lib/control-ui-i18n-catalog.ts";',
          "const catalog = loadControlUiSourceCatalog();",
          "console.log(JSON.stringify(catalog));",
        ].join("\n"),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const catalog: unknown = JSON.parse(result.stdout);
    const source = flattenCatalog(catalog, "en");
    for (const fragment of [
      registerCodeBlocksEnglish.catalog,
      registerLabsEnglish.catalog,
      registerSettingsEnglish.catalog,
      registerTranscriptsEnglish.catalog,
    ]) {
      const lazyCopy = flattenCatalog(fragment, "lazy copy");
      for (const [key, value] of lazyCopy) {
        expect(source.get(key), key).toBe(value);
      }
    }
    expect(source.get("meetingCapture.title")).toBe("Meeting capture");
    expect(source.get("meetingCapture.sources")).toBe("Auto-start sources");
  });

  const locale = (name: string) => `ui/src/i18n/locales/${name}.ts`;
  const generated = (name: string) => `ui/src/i18n/.i18n/${name}`;
  const isolationError =
    "Control UI generated locale artifacts must be isolated from source changes";
  const isolated = (...args: Parameters<typeof assertControlUiGeneratedArtifactsIsolated>) =>
    expect(() => assertControlUiGeneratedArtifactsIsolated(...args));
  it("keeps generated locale snapshots out of source PRs", () => {
    isolated([locale("en"), locale("de"), generated("de.meta.json")]).toThrow(isolationError);
    isolated([
      generated("catalog-fallbacks.json"),
      generated("de.meta.json"),
      generated("de.tm.jsonl"),
    ]).not.toThrow();
    isolated([locale("de"), generated("glossary.de.json")]).not.toThrow();
    isolated([generated("catalog-fallbacks.json"), generated("raw-copy-baseline.json")]).toThrow(
      isolationError,
    );
    isolated([locale("en"), generated("raw-copy-baseline.json")]).not.toThrow();
    isolated(["package.json", locale("de")], "release/2026.7.3").not.toThrow();
    isolated(["package.json", locale("de")], "main").not.toThrow();
    expect(
      [[locale("de")], [generated("de.tm.jsonl")], [locale("en")], null].map(
        shouldStrictControlUiI18n,
      ),
    ).toEqual([false, true, false, true]);
  });

  it("admits plugin bundle repairs only from the trusted locale publisher", () => {
    const memory = generated("fr.tm.jsonl");
    const bundle = "extensions/example/src/i18n/locales/translated.json";
    const manifest = "extensions/example/openclaw.plugin.json";
    const branch = "automation/control-ui-locale-refresh";
    const trusted = allowedBranch(
      { GITHUB_ACTIONS: "true", OPENCLAW_ALLOW_RELEASE_GENERATED_MIX: "true" },
      branch,
    );
    const fork = allowedBranch({ GITHUB_ACTIONS: "true" }, branch);
    isolated([memory, bundle, manifest], trusted).not.toThrow();
    isolated([memory, bundle, manifest], fork).toThrow("must be isolated");
    isolated([memory, manifest], "feature").toThrow("must be isolated");
    isolated([memory, "extensions/example/src/i18n/locales/en.ts"], trusted).toThrow(
      "must be isolated",
    );
    isolated([bundle, "extensions/example/src/i18n/locales/en.ts"]).not.toThrow();
    expect(shouldStrictControlUiI18n(["extensions/example/src/i18n/.i18n/fr.tm.jsonl"])).toBe(true);
  });

  it("allows only a complete canonical translation-memory ownership migration", () => {
    const locales = readdirSync(path.resolve("ui/src/i18n/.i18n"))
      .filter((fileName) => fileName.endsWith(".tm.jsonl"))
      .map((fileName) => fileName.slice(0, -".tm.jsonl".length));
    const owners = [
      ".gitattributes",
      "scripts/ci-changed-scope.mjs",
      "scripts/control-ui-i18n.ts",
      "scripts/control-ui-i18n-verify.ts",
      "scripts/lib/control-ui-i18n-catalog.ts",
      "scripts/lib/control-ui-i18n-catalog-values.ts",
      "scripts/lib/control-ui-i18n-sync-plan.ts",
      "ui/AGENTS.md",
      "ui/config/control-ui-locales.ts",
      "ui/vite.config.ts",
    ];
    const adapters = locales.map(locale);
    const artifacts = [
      generated("catalog-fallbacks.json"),
      ...locales.flatMap((language) => [
        generated(`${language}.tm.jsonl`),
        generated(`${language}.meta.json`),
      ]),
    ];
    const migration = [...owners, ...adapters, ...artifacts];
    isolated(migration).not.toThrow();
    isolated(migration.slice(1)).toThrow(isolationError);
    isolated(migration.filter((filePath) => filePath !== artifacts[1])).toThrow(isolationError);
    isolated([...migration, generated("other.tm.jsonl")]).toThrow(isolationError);
  });

  it.each([
    ["push", "refs/heads/main", "main", "true", "main"],
    ["pull_request", "refs/pull/1/merge", "main", "true", ""],
    [undefined, undefined, "release/2026.7.3", "true", "release/2026.7.3"],
    [undefined, undefined, "release/2026.7.3", undefined, ""],
  ])(
    "gates release output for %s on %s (%s, trusted=%s)",
    (event, ref, branch, trusted, expected) => {
      const env = {
        GITHUB_ACTIONS: "true",
        OPENCLAW_ALLOW_RELEASE_GENERATED_MIX: trusted,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
      };
      expect(allowedBranch(env, branch)).toBe(expected);
    },
  );
});

describe("control-ui-i18n catalog validation", () => {
  const batch = (key = "configView.viewPendingChange", text = "View pending change ({count})") => [
    { cacheKey: "cache-key", key, text, textHash: "text-hash" },
  ];
  it("points strict catalog drift at the generated release repair", () => {
    const message = formatControlUiCatalogFallbackDriftError();

    expect(message).toContain("pnpm ui:i18n:sync");
    expect(message).toContain("pnpm release:prep");
    expect(message).not.toContain("pnpm ui:i18n:baseline");
  });

  it("builds a deterministic fallback list without accepting catalog drift", () => {
    const source = flattenCatalog({ group: { first: "First {count}", second: "Second" } }, "en");
    const analyze = (locales: Record<string, Record<string, string>>) =>
      analyzeControlUiCatalogs(
        source,
        new Map(Object.entries(locales).map(([locale, values]) => [locale, strings(values)])),
      );
    expect(
      analyze({
        de: { "group.first": "Erste {count}" },
        fr: { "group.first": "Premiere {count}" },
      }),
    ).toEqual({
      errors: [],
      fallbacks: { "group.second": ["de", "fr"] },
    });

    expect(
      analyze({
        fr: {
          "group.second": "Deuxieme",
          "group.first": "Premiere",
          "group.orphan": "Orpheline",
        },
      }),
    ).toEqual({
      errors: [
        "fr: orphan keys: group.orphan",
        "fr: keys are not in English catalog order",
        "fr:group.first expected {count} got {}",
      ],
      fallbacks: {},
    });
  });

  it("rejects invalid catalog leaf values", () => {
    expect(() => flattenCatalog({ group: { title: 42 } }, "fr")).toThrow(
      "fr:group.title must be a string or object",
    );
  });

  it("rejects literal keys and template prefixes missing from the English catalog", () => {
    const source = flattenCatalog(
      { common: { ok: "OK" }, workboard: { status: { ready: "Ready" } } },
      "en",
    );
    const content = [
      't("common.ok");',
      't("common.missing");',
      "t(`workboard.status.${status}`);",
      "t(`workboard.missing.${status}`);",
    ].join("\n");

    expect(() =>
      verifyKeys(source, [{ content, relativeFile: "ui/src/pages/example.ts" }]),
    ).toThrowError(
      [
        "control-ui referenced translation key verification failed.",
        'ui/src/pages/example.ts:2: missing English catalog key "common.missing"',
        'ui/src/pages/example.ts:4: missing English catalog subtree "workboard.missing."',
      ].join("\n"),
    );
  });

  it("finds raw text and attributes split by template interpolation", () => {
    const source =
      'const jsx = <button aria-label="Archive" />; const view = html`<button title="Delete ${name}">Delete ${name}</button>`; const image = html`<img alt="Preview" />`; menu.setAttribute("aria-label", "Selection actions"); reply.setAttribute("aria-label", `Reply to ${name}`); file.setAttribute("title", "Open " + fileName);';
    const sourceFile = parser.parseSourceFile("ui/src/pages/example.tsx", source);

    expect(
      collectControlUiRawCopyFromSource(sourceFile).map(({ kind, text }) => ({ kind, text })),
    ).toEqual([
      { kind: "html-attribute", text: "Preview" },
      { kind: "html-attribute", text: "Archive" },
      { kind: "html-attribute", text: "Delete" },
      { kind: "html-text", text: "Delete" },
      { kind: "html-attribute", text: "Selection actions" },
      { kind: "html-attribute", text: "Reply to" },
      { kind: "html-attribute", text: "Open" },
    ]);
  });

  it("keeps verification keyless even when provider credentials exist", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/control-ui-i18n-verify.ts", "verify"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "redacted",
          OPENAI_API_KEY: "redacted",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("source:");
    expect(result.stdout).not.toContain("provider=openai");
    expect(result.stdout).not.toContain("provider=anthropic");
  });

  it("rejects placeholder-corrupt batch replies before they leave the retry loop", () => {
    const key = "configView.viewPendingChange";
    const items = batch(key);
    const parse = (text: string) =>
      parseTranslationBatchReply(JSON.stringify({ [key]: text }), items, "ar");
    expect(() => parse("Pending change")).toThrow(
      "ar:configView.viewPendingChange expected {count} got {}",
    );
    expect(parse("Pending change ({count})")).toEqual(
      strings({ [key]: "Pending change ({count})" }),
    );
  });

  it("runs an optional result validator before accepting a batch reply", () => {
    const items = batch("native.apple.progress", "Processed %lld of %@");
    const reply = JSON.stringify({ "native.apple.progress": "Bearbetade %@" });
    const validate = (source: string, translated: string, key: string, locale: string) => {
      if (source.includes("%lld") && !translated.includes("%lld")) {
        throw new Error(`invalid structural tokens for ${locale}:${key}`);
      }
    };
    expect(() => parseTranslationBatchReply(reply, items, "sv", validate)).toThrow(
      "invalid structural tokens for sv:native.apple.progress",
    );
  });

  it("makes placeholder-incompatible existing copy pending for bot repair", () => {
    const reusable = filterPlaceholderCompatibleTranslations(
      strings({ changed: "Waiting for {total}", same: "Waiting for {count}" }),
      strings({ changed: "Warten auf {count}", same: "Warten auf {count}" }),
    );

    expect([...reusable]).toEqual([["same", "Warten auf {count}"]]);
  });

  it("feeds the exact validation failure back into a retry prompt", () => {
    const items = batch();
    const validationError = "ar:configView.viewPendingChange expected {count} got {}";

    expect(buildBatchPrompt(items, validationError)).toContain(
      `failed validation. Correct that exact failure in the new response:\n${validationError}`,
    );
  });

  it("ships no recorded English fallbacks", () => {
    const metaDir = path.resolve("ui/src/i18n/.i18n");
    const fallbacks = readdirSync(metaDir)
      .filter((fileName) => fileName.endsWith(".meta.json"))
      .flatMap((fileName) => {
        const meta = JSON.parse(readFileSync(path.join(metaDir, fileName), "utf8")) as {
          fallbackKeys?: string[];
          locale?: string;
        };
        return (meta.fallbackKeys ?? []).map((key) => `${meta.locale ?? fileName}:${key}`);
      });

    expect(fallbacks).toEqual([]);
  });

  it("makes the strict gate reject recorded English fallbacks", () => {
    const assertFallbacks = (fallbackCount: number) => () =>
      assertNoControlUiFallbacks([
        { fallbackCount: 0, locale: "de" },
        { fallbackCount, locale: "fr" },
      ]);
    expect(assertFallbacks(2)).toThrow("fr: 2 fallback keys");
    expect(assertFallbacks(0)).not.toThrow();
  });
});
