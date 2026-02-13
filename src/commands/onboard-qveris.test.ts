import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { DEFAULT_QVERIS_WEB_SEARCH_TOOL_ID, promptQverisConfig } from "./onboard-qveris.js";

function createPrompter(params: {
  confirmValue: boolean;
  textValue: string;
  note?: ReturnType<typeof vi.fn>;
}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: params.note ?? vi.fn(async () => {}),
    select: vi.fn(async () => ""),
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

  it("enables qveris and configures web_search provider defaults", async () => {
    const prompter = createPrompter({
      confirmValue: true,
      textValue: "qv_test_key",
    });

    const next = await promptQverisConfig({} as OpenClawConfig, prompter);

    expect(next.tools?.qveris?.enabled).toBe(true);
    expect(next.tools?.qveris?.apiKey).toBe("qv_test_key");
    expect(next.tools?.web?.search?.enabled).toBe(true);
    expect(next.tools?.web?.search?.provider).toBe("qveris");
    expect(next.tools?.web?.search?.qveris?.toolId).toBe(DEFAULT_QVERIS_WEB_SEARCH_TOOL_ID);
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

  it("accepts env key and still defaults web_search to qveris", async () => {
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
    expect(next.tools?.web?.search?.provider).toBe("qveris");
    expect(note).toHaveBeenCalled();
  });
});
