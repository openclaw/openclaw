import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

import { setupMemorySearch } from "./onboard-memory-search.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

function createPrompter(params: {
  confirmValues?: boolean[];
  selectValues?: string[];
  textValues?: string[];
}): WizardPrompter {
  const confirmValues = [...(params.confirmValues ?? [])];
  const selectValues = [...(params.selectValues ?? [])];
  const textValues = [...(params.textValues ?? [])];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => (selectValues.shift() ?? "openai")) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => textValues.shift() ?? ""),
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("setupMemorySearch", () => {
  it("disables memory search when user skips enablement", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({ confirmValues: [false] });

    const result = await setupMemorySearch(cfg, runtime, prompter);

    expect(result.agents?.defaults?.memorySearch?.enabled).toBe(false);
    expect(prompter.select).not.toHaveBeenCalled();
  });

  it("configures openai provider with plaintext apiKey", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirmValues: [true],
      selectValues: ["openai"],
      textValues: ["text-embedding-3-small", "sk-test-key"],
    });

    const result = await setupMemorySearch(cfg, runtime, prompter);

    expect(result.agents?.defaults?.memorySearch?.enabled).toBe(true);
    expect(result.agents?.defaults?.memorySearch?.provider).toBe("openai");
    expect(result.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("sk-test-key");
    expect(resolveMemorySearchConfig).toHaveBeenCalled();
  });

  it("stores env SecretRef in ref mode when api key is blank", async () => {
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirmValues: [true],
      selectValues: ["gemini"],
      textValues: ["gemini-embedding-001", ""],
    });

    const result = await setupMemorySearch(cfg, runtime, prompter, {
      secretInputMode: "ref",
    });

    expect(result.agents?.defaults?.memorySearch?.remote?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "GEMINI_API_KEY",
    });
  });

  it("blocks invalid config and allows skip on validation failure", async () => {
    resolveMemorySearchConfig.mockImplementationOnce(() => {
      throw new Error("memorySearch.provider=openai requires:\n- remote.apiKey");
    });
    const cfg: OpenClawConfig = {};
    const prompter = createPrompter({
      confirmValues: [true],
      selectValues: ["openai", "__skip__"],
      textValues: ["text-embedding-3-small", ""],
    });

    const result = await setupMemorySearch(cfg, runtime, prompter);

    expect(result.agents?.defaults?.memorySearch?.enabled).toBe(false);
    expect(prompter.note).toHaveBeenCalled();
  });
});
