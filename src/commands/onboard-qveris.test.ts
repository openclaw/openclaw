import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptQverisConfig } from "./onboard-qveris.js";

function createPrompter(params: {
  confirmValue: boolean;
  textValue: string;
  selectValue?: string;
  note?: WizardPrompter["note"];
}): WizardPrompter {
  const note = params.note ?? (vi.fn(async () => {}) as unknown as WizardPrompter["note"]);
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note,
    select: vi.fn(
      async () => params.selectValue ?? "global",
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => params.textValue),
    confirm: vi.fn(async () => params.confirmValue),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("promptQverisConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enables qveris tool search without touching web search config", async () => {
    const prompter = createPrompter({
      confirmValue: true,
      textValue: "qv_test_key",
    });

    const next = await promptQverisConfig({} as OpenClawConfig, prompter);

    expect(next.tools?.qveris?.enabled).toBe(true);
    expect(next.tools?.qveris?.apiKey).toBe("qv_test_key");
    expect((next.tools?.qveris as Record<string, unknown>)?.region).toBe("global");
    expect(next.tools?.web?.search?.provider).toBeUndefined();
  });

  it("disables qveris when user opts out", async () => {
    const prompter = createPrompter({
      confirmValue: false,
      textValue: "",
    });

    const next = await promptQverisConfig(
      {
        tools: {
          qveris: {
            enabled: true,
            apiKey: "qv_existing",
          },
        },
      } as OpenClawConfig,
      prompter,
    );

    expect(next.tools?.qveris?.enabled).toBe(false);
    expect(next.tools?.qveris?.apiKey).toBe("qv_existing");
    expect(next.tools?.web?.search?.provider).toBeUndefined();
  });

  it("accepts env key without storing it in config", async () => {
    vi.stubEnv("QVERIS_API_KEY", "qv_env_key");
    const note = vi.fn(async () => {});
    const prompter = createPrompter({
      confirmValue: true,
      textValue: "",
      note,
    });

    const next = await promptQverisConfig({} as OpenClawConfig, prompter);

    expect(next.tools?.qveris?.enabled).toBe(true);
    expect(next.tools?.qveris?.apiKey).toBeUndefined();
    expect(next.tools?.web?.search?.provider).toBeUndefined();
    expect(note).toHaveBeenCalled();
  });

  it("preserves existing web search config when enabling qveris", async () => {
    const prompter = createPrompter({
      confirmValue: true,
      textValue: "qv_test_key",
    });

    const next = await promptQverisConfig(
      {
        tools: {
          web: { search: { provider: "brave", apiKey: "BSA-existing" } },
        },
      } as OpenClawConfig,
      prompter,
    );

    expect(next.tools?.qveris?.enabled).toBe(true);
    expect(next.tools?.web?.search?.provider).toBe("brave");
    expect(next.tools?.web?.search?.apiKey).toBe("BSA-existing");
  });

  it("stores cn region when user selects China", async () => {
    const prompter = createPrompter({
      confirmValue: true,
      textValue: "qv_cn_key",
      selectValue: "cn",
    });

    const next = await promptQverisConfig({} as OpenClawConfig, prompter);

    expect(next.tools?.qveris?.enabled).toBe(true);
    expect((next.tools?.qveris as Record<string, unknown>)?.region).toBe("cn");
    expect(next.tools?.qveris?.apiKey).toBe("qv_cn_key");
  });
});
