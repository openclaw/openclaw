/**
 * PR-8 follow-up Round 2: tests for the GPT-5 family context-file boot
 * reorder — SOUL.md / IDENTITY.md should load BEFORE AGENTS.md when the
 * provider is `openai` or `openai-codex` and the model id starts with
 * `gpt-5`. All other providers/models preserve the historical default
 * order (AGENTS.md first).
 *
 * Scope: asserts final placement order inside the assembled prompt's
 * "## Stable Project Context" section via the public
 * `buildAgentSystemPrompt` entrypoint (no internal helper exposure).
 */
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type ContextFile = Parameters<typeof buildAgentSystemPrompt>[0]["contextFiles"] extends
  | ReadonlyArray<infer E>
  | undefined
  ? E
  : never;

function makeCtxFile(basename: string, content: string): ContextFile {
  return {
    path: basename,
    content,
  } as ContextFile;
}

function extractContextSectionOrder(prompt: string): string[] {
  // Each injected file lands as `## <path>` under the "Stable Project
  // Context" section. Capture only basenames in `.md` to avoid false
  // positives from other `## `-prefixed section headings.
  const headingRe = /^## (?<path>[A-Za-z0-9_.-]+\.md)$/gm;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(prompt)) !== null) {
    if (m.groups?.path) {
      matches.push(m.groups.path.toLowerCase());
    }
  }
  return matches;
}

const BASE_PARAMS = {
  workspaceDir: "/tmp/gpt5-boot-order-test",
  runtimeInfo: {
    host: "test-host",
    os: "darwin",
    arch: "arm64",
    node: "v22.0.0",
    model: "placeholder",
  },
  contextFiles: [
    makeCtxFile("AGENTS.md", "# agents content"),
    makeCtxFile("SOUL.md", "# soul content"),
    makeCtxFile("IDENTITY.md", "# identity content"),
    makeCtxFile("USER.md", "# user content"),
    makeCtxFile("TOOLS.md", "# tools content"),
  ],
};

describe("GPT-5 context-file boot reorder", () => {
  it("openai-codex + gpt-5.4 → SOUL first, then IDENTITY, then AGENTS", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "openai-codex",
      modelId: "gpt-5.4",
    });
    const order = extractContextSectionOrder(prompt);
    const soulIdx = order.indexOf("soul.md");
    const identityIdx = order.indexOf("identity.md");
    const agentsIdx = order.indexOf("agents.md");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(soulIdx);
    expect(agentsIdx).toBeGreaterThan(identityIdx);
  });

  it("openai + gpt-5-turbo → SOUL first, then IDENTITY, then AGENTS", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "openai",
      modelId: "gpt-5-turbo",
    });
    const order = extractContextSectionOrder(prompt);
    expect(order.indexOf("soul.md")).toBeLessThan(order.indexOf("agents.md"));
    expect(order.indexOf("identity.md")).toBeLessThan(order.indexOf("agents.md"));
  });

  it("anthropic + claude-opus-4-6 → default order (AGENTS first)", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "anthropic",
      modelId: "claude-opus-4-6",
    });
    const order = extractContextSectionOrder(prompt);
    const agentsIdx = order.indexOf("agents.md");
    const soulIdx = order.indexOf("soul.md");
    const identityIdx = order.indexOf("identity.md");
    expect(agentsIdx).toBeLessThan(soulIdx);
    expect(agentsIdx).toBeLessThan(identityIdx);
  });

  it("openai + gpt-4 (non-GPT-5) → default order preserved", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "openai",
      modelId: "gpt-4.1",
    });
    const order = extractContextSectionOrder(prompt);
    expect(order.indexOf("agents.md")).toBeLessThan(order.indexOf("soul.md"));
  });

  it("missing modelProviderId/modelId → default order (safe fallback)", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
    });
    const order = extractContextSectionOrder(prompt);
    expect(order.indexOf("agents.md")).toBeLessThan(order.indexOf("soul.md"));
  });

  it("GPT-5 with mixed case modelId (GPT-5.4) still triggers reorder", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "openai-codex",
      modelId: "GPT-5.4",
    });
    const order = extractContextSectionOrder(prompt);
    expect(order.indexOf("soul.md")).toBeLessThan(order.indexOf("agents.md"));
  });

  it("non-OpenAI provider with gpt-5 in name → default order (provider gate required)", () => {
    const prompt = buildAgentSystemPrompt({
      ...BASE_PARAMS,
      modelProviderId: "anthropic",
      modelId: "gpt-5",
    });
    const order = extractContextSectionOrder(prompt);
    // Provider gate fails → no reorder
    expect(order.indexOf("agents.md")).toBeLessThan(order.indexOf("soul.md"));
  });
});
