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
  it("parses mdl_prov callback", () => {
    const result = parseModelCallbackData("mdl_prov");
    expect(result).toEqual({ type: "providers" });
  });

  it("parses mdl_back callback", () => {
    const result = parseModelCallbackData("mdl_back");
    expect(result).toEqual({ type: "back" });
  });

  it("parses mdl_list callback with provider and page", () => {
    const result = parseModelCallbackData("mdl_list_anthropic_2");
    expect(result).toEqual({ type: "list", provider: "anthropic", page: 2 });
  });

  it("parses mdl_list callback with hyphenated provider", () => {
    const result = parseModelCallbackData("mdl_list_open-ai_1");
    expect(result).toEqual({ type: "list", provider: "open-ai", page: 1 });
  });

  it("parses mdl_sel callback with provider/model", () => {
    const result = parseModelCallbackData("mdl_sel_anthropic/claude-sonnet-4-5");
    expect(result).toEqual({
      type: "select",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  it("parses mdl_sel callback with nested model path", () => {
    const result = parseModelCallbackData("mdl_sel_openai/gpt-4/turbo");
    expect(result).toEqual({
      type: "select",
      provider: "openai",
      model: "gpt-4/turbo",
    });
  });

  it("returns null for non-model callback data", () => {
    expect(parseModelCallbackData("commands_page_1")).toBeNull();
    expect(parseModelCallbackData("other_callback")).toBeNull();
    expect(parseModelCallbackData("")).toBeNull();
  });

  it("returns null for invalid mdl_ patterns", () => {
    expect(parseModelCallbackData("mdl_invalid")).toBeNull();
    expect(parseModelCallbackData("mdl_list_")).toBeNull();
    expect(parseModelCallbackData("mdl_sel_noslash")).toBeNull();
  });

  it("handles whitespace in callback data", () => {
    expect(parseModelCallbackData("  mdl_prov  ")).toEqual({ type: "providers" });
  });
});

describe("buildProviderKeyboard", () => {
  it("returns empty array for no providers", () => {
    const result = buildProviderKeyboard([]);
    expect(result).toEqual([]);
  });

  it("builds single provider as one row", () => {
    const providers: ProviderInfo[] = [{ id: "anthropic", count: 5 }];
    const result = buildProviderKeyboard(providers);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("anthropic (5)");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_list_anthropic_1");
  });

  it("builds two providers per row", () => {
    const providers: ProviderInfo[] = [
      { id: "anthropic", count: 5 },
      { id: "openai", count: 8 },
    ];
    const result = buildProviderKeyboard(providers);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    expect(result[0]?.[0]?.text).toBe("anthropic (5)");
    expect(result[0]?.[1]?.text).toBe("openai (8)");
  });

  it("wraps to next row after two providers", () => {
    const providers: ProviderInfo[] = [
      { id: "anthropic", count: 5 },
      { id: "openai", count: 8 },
      { id: "google", count: 3 },
    ];
    const result = buildProviderKeyboard(providers);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(2);
    expect(result[1]).toHaveLength(1);
    expect(result[1]?.[0]?.text).toBe("google (3)");
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

  it("shows models with one per row", () => {
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["claude-sonnet-4", "claude-opus-4"],
      currentPage: 1,
      totalPages: 1,
    });
    // 2 model rows + back button
    expect(result).toHaveLength(3);
    expect(result[0]?.[0]?.text).toBe("claude-sonnet-4");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_anthropic/claude-sonnet-4");
    expect(result[1]?.[0]?.text).toBe("claude-opus-4");
    expect(result[2]?.[0]?.text).toBe("<< Back");
  });

  it("marks current model with checkmark", () => {
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["claude-sonnet-4", "claude-opus-4"],
      currentModel: "anthropic/claude-sonnet-4",
      currentPage: 1,
      totalPages: 1,
    });
    expect(result[0]?.[0]?.text).toBe("claude-sonnet-4 ✓");
    expect(result[1]?.[0]?.text).toBe("claude-opus-4");
  });

  it("shows pagination when multiple pages", () => {
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["model1", "model2"],
      currentPage: 1,
      totalPages: 3,
      pageSize: 2,
    });
    // 2 model rows + pagination row + back button
    expect(result).toHaveLength(4);
    const paginationRow = result[2];
    expect(paginationRow).toHaveLength(2); // no prev on first page
    expect(paginationRow?.[0]?.text).toBe("1/3");
    expect(paginationRow?.[1]?.text).toBe("Next ▶");
  });

  it("shows prev and next on middle pages", () => {
    // 6 models with pageSize 2 = 3 pages
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["model1", "model2", "model3", "model4", "model5", "model6"],
      currentPage: 2,
      totalPages: 3,
      pageSize: 2,
    });
    // 2 model rows + pagination row + back button
    expect(result).toHaveLength(4);
    const paginationRow = result[2];
    expect(paginationRow).toHaveLength(3);
    expect(paginationRow?.[0]?.text).toBe("◀ Prev");
    expect(paginationRow?.[1]?.text).toBe("2/3");
    expect(paginationRow?.[2]?.text).toBe("Next ▶");
  });

  it("shows only prev on last page", () => {
    // 6 models with pageSize 2 = 3 pages
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["model1", "model2", "model3", "model4", "model5", "model6"],
      currentPage: 3,
      totalPages: 3,
      pageSize: 2,
    });
    // 2 model rows + pagination row + back button
    expect(result).toHaveLength(4);
    const paginationRow = result[2];
    expect(paginationRow).toHaveLength(2);
    expect(paginationRow?.[0]?.text).toBe("◀ Prev");
    expect(paginationRow?.[1]?.text).toBe("3/3");
  });

  it("truncates long model IDs", () => {
    const longModel = "this-is-a-very-long-model-name-that-exceeds-the-limit";
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: [longModel],
      currentPage: 1,
      totalPages: 1,
    });
    const text = result[0]?.[0]?.text;
    expect(text?.startsWith("…")).toBe(true);
    expect(text?.length).toBeLessThanOrEqual(39); // 38 max + possible checkmark
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
