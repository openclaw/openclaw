import { describe, expect, it } from "vitest";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  buildBrowseProvidersButton,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";

describe("parseModelCallbackData", () => {
  it("parses supported callback variants", () => {
    const cases = [
      ["mdl_prov", { type: "providers" }],
      ["mdl_back", { type: "back" }],
      ["mdl_list_anthropic_2", { type: "list", provider: "anthropic", page: 2 }],
      ["mdl_list_open-ai_1", { type: "list", provider: "open-ai", page: 1 }],
      [
        "mdl_sel_anthropic/claude-sonnet-4-5",
        { type: "select", provider: "anthropic", model: "claude-sonnet-4-5" },
      ],
      ["mdl_sel_openai/gpt-4/turbo", { type: "select", provider: "openai", model: "gpt-4/turbo" }],
      ["  mdl_prov  ", { type: "providers" }],
    ] as const;
    for (const [input, expected] of cases) {
      expect(parseModelCallbackData(input), input).toEqual(expected);
    }
  });

  it("returns null for unsupported callback variants", () => {
    const invalid = [
      "commands_page_1",
      "other_callback",
      "",
      "mdl_invalid",
      "mdl_list_",
      "mdl_sel_noslash",
    ];
    for (const input of invalid) {
      expect(parseModelCallbackData(input), input).toBeNull();
    }
  });
});

describe("buildProviderKeyboard", () => {
  it("lays out providers in two-column rows", () => {
    const cases = [
      {
        name: "empty input",
        input: [],
        expected: [],
      },
      {
        name: "single provider",
        input: [{ id: "anthropic", count: 5 }],
        expected: [[{ text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" }]],
      },
      {
        name: "exactly one full row",
        input: [
          { id: "anthropic", count: 5 },
          { id: "openai", count: 8 },
        ],
        expected: [
          [
            { text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" },
            { text: "openai (8)", callback_data: "mdl_list_openai_1" },
          ],
        ],
      },
      {
        name: "wraps overflow to second row",
        input: [
          { id: "anthropic", count: 5 },
          { id: "openai", count: 8 },
          { id: "google", count: 3 },
        ],
        expected: [
          [
            { text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" },
            { text: "openai (8)", callback_data: "mdl_list_openai_1" },
          ],
          [{ text: "google (3)", callback_data: "mdl_list_google_1" }],
        ],
      },
    ] as const satisfies Array<{
      name: string;
      input: ProviderInfo[];
      expected: ReturnType<typeof buildProviderKeyboard>;
    }>;

    for (const testCase of cases) {
      expect(buildProviderKeyboard(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("buildModelsKeyboard", () => {
  it("shows back button for empty models", () => {
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: [],
      currentPage: 1,
      totalPages: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("<< Back");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_back");
  });

  it("renders model rows and optional current-model indicator", () => {
    const cases = [
      {
        name: "no current model",
        currentModel: undefined,
        firstText: "claude-sonnet-4",
      },
      {
        name: "current model marked",
        currentModel: "anthropic/claude-sonnet-4",
        firstText: "claude-sonnet-4 ✓",
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: "anthropic",
        models: ["claude-sonnet-4", "claude-opus-4"],
        currentModel: testCase.currentModel,
        currentPage: 1,
        totalPages: 1,
      });
      // 2 model rows + back button
      expect(result, testCase.name).toHaveLength(3);
      expect(result[0]?.[0]?.text).toBe(testCase.firstText);
      expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_anthropic/claude-sonnet-4");
      expect(result[1]?.[0]?.text).toBe("claude-opus-4");
      expect(result[2]?.[0]?.text).toBe("<< Back");
    }
  });

  it("renders pagination controls for first, middle, and last pages", () => {
    const cases = [
      {
        name: "first page",
        params: { currentPage: 1, models: ["model1", "model2"] },
        expectedPagination: ["1/3", "Next ▶"],
      },
      {
        name: "middle page",
        params: {
          currentPage: 2,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
        expectedPagination: ["◀ Prev", "2/3", "Next ▶"],
      },
      {
        name: "last page",
        params: {
          currentPage: 3,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
        expectedPagination: ["◀ Prev", "3/3"],
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: "anthropic",
        models: [...testCase.params.models],
        currentPage: testCase.params.currentPage,
        totalPages: 3,
        pageSize: 2,
      });
      // 2 model rows + pagination row + back button
      expect(result, testCase.name).toHaveLength(4);
      expect(result[2]?.map((button) => button.text)).toEqual(testCase.expectedPagination);
    }
  });

  it("keeps short display IDs untouched and truncates overly long IDs", () => {
    const cases = [
      {
        name: "max-length display",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022-with-suffix",
        expected: "claude-3-5-sonnet-20241022-with-suffix",
      },
      {
        name: "overly long display",
        provider: "a",
        model: "this-model-name-is-long-enough-to-need-truncation-abcd",
        startsWith: "…",
        maxLength: 38,
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: testCase.provider,
        models: [testCase.model],
        currentPage: 1,
        totalPages: 1,
      });
      const text = result[0]?.[0]?.text;
      if ("expected" in testCase) {
        expect(text, testCase.name).toBe(testCase.expected);
      } else {
        expect(text?.startsWith(testCase.startsWith), testCase.name).toBe(true);
        expect(text?.length, testCase.name).toBeLessThanOrEqual(testCase.maxLength);
      }
    }
  });
});

describe("buildBrowseProvidersButton", () => {
  it("returns browse providers button", () => {
    const result = buildBrowseProvidersButton();
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("Browse providers");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_prov");
  });
});

describe("getModelsPageSize", () => {
  it("returns default page size", () => {
    expect(getModelsPageSize()).toBe(8);
  });
});

describe("calculateTotalPages", () => {
  it("calculates pages correctly", () => {
    expect(calculateTotalPages(0)).toBe(0);
    expect(calculateTotalPages(1)).toBe(1);
    expect(calculateTotalPages(8)).toBe(1);
    expect(calculateTotalPages(9)).toBe(2);
    expect(calculateTotalPages(16)).toBe(2);
    expect(calculateTotalPages(17)).toBe(3);
  });

  it("uses custom page size", () => {
    expect(calculateTotalPages(10, 5)).toBe(2);
    expect(calculateTotalPages(11, 5)).toBe(3);
  });
});

describe("large model lists (OpenRouter-scale)", () => {
  it("handles 100+ models with pagination", () => {
    const models = Array.from({ length: 150 }, (_, i) => `model-${i}`);
    const totalPages = calculateTotalPages(models.length);
    expect(totalPages).toBe(19); // 150 / 8 = 18.75 -> 19 pages

    // Test first page
    const firstPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages,
    });
    expect(firstPage.length).toBe(10); // 8 models + pagination + back
    expect(firstPage[0]?.[0]?.text).toBe("model-0");
    expect(firstPage[7]?.[0]?.text).toBe("model-7");

    // Test last page
    const lastPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 19,
      totalPages,
    });
    // Last page has 150 - (18 * 8) = 6 models
    expect(lastPage.length).toBe(8); // 6 models + pagination + back
    expect(lastPage[0]?.[0]?.text).toBe("model-144");
  });

  it("all callback_data stays within 64-byte limit", () => {
    // Realistic OpenRouter model IDs
    const models = [
      "anthropic/claude-3-5-sonnet-20241022",
      "google/gemini-2.0-flash-thinking-exp:free",
      "deepseek/deepseek-r1-distill-llama-70b",
      "meta-llama/llama-3.3-70b-instruct:nitro",
      "nousresearch/hermes-3-llama-3.1-405b:extended",
    ];
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages: 1,
    });

    for (const row of result) {
      for (const button of row) {
        const bytes = Buffer.byteLength(button.callback_data, "utf8");
        expect(bytes).toBeLessThanOrEqual(64);
      }
    }
  });

  it("skips models that would exceed callback_data limit", () => {
    const models = [
      "short-model",
      "this-is-an-extremely-long-model-name-that-definitely-exceeds-the-sixty-four-byte-limit",
      "another-short",
    ];
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages: 1,
    });

    // Should have 2 model buttons (skipping the long one) + back
    const modelButtons = result.filter((row) => !row[0]?.callback_data.startsWith("mdl_back"));
    expect(modelButtons.length).toBe(2);
    expect(modelButtons[0]?.[0]?.text).toBe("short-model");
    expect(modelButtons[1]?.[0]?.text).toBe("another-short");
  });
});
