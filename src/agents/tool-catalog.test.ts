import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("includes web_search, web_fetch, x_search, and image_generate in the coding profile policy", () => {
    const policy = resolveCoreToolProfilePolicy("coding");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("web_search");
    expect(policy!.allow).toContain("web_fetch");
    expect(policy!.allow).toContain("x_search");
    expect(policy!.allow).toContain("image_generate");
  });
});
