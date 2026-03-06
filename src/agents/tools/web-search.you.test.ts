import { describe, expect, test } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { __testing } from "./web-search.js";

const { resolveYouApiKey, freshnessToYouRecency, resolveSearchProvider } = __testing;

describe("web_search you.com resolveYouApiKey", () => {
  test("returns config key when set", () => {
    expect(resolveYouApiKey({ apiKey: "ydc-config-key" })).toBe("ydc-config-key");
  });

  test("returns YDC_API_KEY from env", () => {
    withEnv({ YDC_API_KEY: "ydc-env-key" }, () => {
      expect(resolveYouApiKey({})).toBe("ydc-env-key");
    });
  });

  test("prefers config key over env", () => {
    withEnv({ YDC_API_KEY: "ydc-env-key" }, () => {
      expect(resolveYouApiKey({ apiKey: "ydc-config-key" })).toBe("ydc-config-key");
    });
  });

  test("returns undefined when no key is available", () => {
    withEnv({ YDC_API_KEY: "" }, () => {
      expect(resolveYouApiKey({})).toBeUndefined();
    });
  });
});

describe("web_search you.com freshnessToYouRecency", () => {
  test("maps pd to day", () => {
    expect(freshnessToYouRecency("pd")).toBe("day");
  });

  test("maps pw to week", () => {
    expect(freshnessToYouRecency("pw")).toBe("week");
  });

  test("maps pm to month", () => {
    expect(freshnessToYouRecency("pm")).toBe("month");
  });

  test("maps py to year", () => {
    expect(freshnessToYouRecency("py")).toBe("year");
  });

  test("returns undefined for unknown value", () => {
    expect(freshnessToYouRecency("unknown")).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(freshnessToYouRecency(undefined)).toBeUndefined();
  });

  test("passes through date range as undefined", () => {
    expect(freshnessToYouRecency("2025-01-01to2025-03-01")).toBeUndefined();
  });
});

describe("web_search you.com provider auto-detection", () => {
  test("resolves explicit 'you' provider", () => {
    expect(resolveSearchProvider({ provider: "you" } as Record<string, unknown>)).toBe("you");
  });

  test("auto-detects you when no other keys are present", () => {
    withEnv(
      {
        BRAVE_API_KEY: "",
        GEMINI_API_KEY: "",
        KIMI_API_KEY: "",
        MOONSHOT_API_KEY: "",
        PERPLEXITY_API_KEY: "",
        OPENROUTER_API_KEY: "",
        XAI_API_KEY: "",
      },
      () => {
        expect(resolveSearchProvider({})).toBe("you");
      },
    );
  });

  test("prefers brave when BRAVE_API_KEY is set", () => {
    withEnv({ BRAVE_API_KEY: "test-brave-key" }, () => {
      expect(resolveSearchProvider({})).toBe("brave");
    });
  });
});
