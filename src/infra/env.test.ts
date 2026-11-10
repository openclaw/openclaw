import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { isFastTestRuntimeEnv, normalizeEnv, normalizeZaiEnv } from "./env.js";

describe("normalizeZaiEnv", () => {
  it("does not override existing ZAI_API_KEY", () => {
    withEnv({ ZAI_API_KEY: "zai-current", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeZaiEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-current");
    });
  });
});

describe("isFastTestRuntimeEnv", () => {
  it.each(["1"])(
    "uses the process fast flag (%j) when the process supplies the test marker",
    (fastFlag) => {
      withEnv({ VITEST: "true", OPENCLAW_TEST_FAST: fastFlag }, () => {
        expect(isFastTestRuntimeEnv()).toBe(fastFlag === "1");
      });
    },
  );
});

describe("normalizeEnv", () => {
  it("normalizes the legacy ZAI env alias", () => {
    withEnv({ ZAI_API_KEY: "", Z_AI_API_KEY: "zai-legacy" }, () => {
      normalizeEnv();
      expect(process.env.ZAI_API_KEY).toBe("zai-legacy");
    });
  });
});
