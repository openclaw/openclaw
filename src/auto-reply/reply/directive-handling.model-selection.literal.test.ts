/** Tests literal fallback for unresolvable mid-message /model directives (#137197). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { ModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

const EMPTY_ALIAS_INDEX = {
  byKey: new Map(),
  byAlias: new Map(),
} as unknown as ModelAliasIndex;

function makePolicy(allowedKey?: string): ModelVisibilityPolicy {
  return {
    allowAny: false,
    allowedCatalog: [],
    allowedKeys: new Set(allowedKey ? [allowedKey] : []),
    policyAliasIndex: EMPTY_ALIAS_INDEX,
    selectionAliasIndex: EMPTY_ALIAS_INDEX,
    configuredKeys: new Set(),
    retainedKeys: new Set(),
    exactModelRefs: allowedKey ? [allowedKey] : [],
    providerWildcards: new Set(),
    hasConfiguredEntries: Boolean(allowedKey),
    hasProviderWildcards: false,
    allowRepairConfigPath: "agents.defaults.modelPolicy.allow",
    allowsKey: (key: string) => key === allowedKey,
  } as unknown as ModelVisibilityPolicy;
}

function makeDirectives(overrides: Partial<InlineDirectives> = {}): Partial<InlineDirectives> {
  return {
    hasModelDirective: true,
    rawModelDirective: "bzw.",
    modelDirectiveSource: "model",
    ...overrides,
  };
}

let agentDir = "";

afterAll(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("resolveModelSelectionFromDirective — mid-message literal fallback", () => {
  it("leaves unresolvable mid-message mentions as prose instead of aborting", () => {
    agentDir = agentDir || mkdtempSync(path.join(tmpdir(), "openclaw-model-directive-"));
    const result = resolveModelSelectionFromDirective({
      directives: makeDirectives({ modelDirectiveMixed: true }) as InlineDirectives,
      cfg: {} as Parameters<typeof resolveModelSelectionFromDirective>[0]["cfg"],
      agentDir,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
      aliasIndex: EMPTY_ALIAS_INDEX,
      allowedModelKeys: new Set<string>(),
      modelPolicy: makePolicy(),
      allowedModelCatalog: [],
      provider: "deepseek",
    });
    expect(result.errorText).toBeUndefined();
    expect(result.modelSelection).toBeUndefined();
  });

  it("still reports directive-only unresolvable selections explicitly", () => {
    agentDir = agentDir || mkdtempSync(path.join(tmpdir(), "openclaw-model-directive-"));
    const result = resolveModelSelectionFromDirective({
      directives: makeDirectives() as InlineDirectives,
      cfg: {} as Parameters<typeof resolveModelSelectionFromDirective>[0]["cfg"],
      agentDir,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
      aliasIndex: EMPTY_ALIAS_INDEX,
      allowedModelKeys: new Set<string>(),
      modelPolicy: makePolicy(),
      allowedModelCatalog: [],
      provider: "deepseek",
    });
    expect(result.errorText).toContain('Model "deepseek/bzw." is not allowed');
    expect(result.modelSelection).toBeUndefined();
  });

  it("keeps mid-message explicit model refs switching", () => {
    agentDir = agentDir || mkdtempSync(path.join(tmpdir(), "openclaw-model-directive-"));
    const result = resolveModelSelectionFromDirective({
      directives: makeDirectives({
        rawModelDirective: "openai/gpt-5.6-sol",
        modelDirectiveMixed: true,
      }) as InlineDirectives,
      cfg: {} as Parameters<typeof resolveModelSelectionFromDirective>[0]["cfg"],
      agentDir,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
      aliasIndex: EMPTY_ALIAS_INDEX,
      allowedModelKeys: new Set(["openai/gpt-5.6-sol"]),
      modelPolicy: makePolicy("openai/gpt-5.6-sol"),
      allowedModelCatalog: [],
      provider: "deepseek",
    });
    expect(result.errorText).toBeUndefined();
    expect(result.modelSelection).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
  });

  it("keeps explicit errors for alias-sourced directives even when mixed", () => {
    agentDir = agentDir || mkdtempSync(path.join(tmpdir(), "openclaw-model-directive-"));
    const result = resolveModelSelectionFromDirective({
      directives: makeDirectives({
        modelDirectiveSource: "alias",
        modelDirectiveMixed: true,
      }) as InlineDirectives,
      cfg: {} as Parameters<typeof resolveModelSelectionFromDirective>[0]["cfg"],
      agentDir,
      defaultProvider: "deepseek",
      defaultModel: "deepseek-chat",
      aliasIndex: EMPTY_ALIAS_INDEX,
      allowedModelKeys: new Set<string>(),
      modelPolicy: makePolicy(),
      allowedModelCatalog: [],
      provider: "deepseek",
    });
    expect(result.errorText).toContain("is not allowed");
  });
});
