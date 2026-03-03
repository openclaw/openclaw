import { describe, expect, it } from "vitest";
import { consumeRootOptionToken } from "./cli-root-options.js";

describe("consumeRootOptionToken", () => {
  it("consumes boolean and inline root options", () => {
    expect(consumeRootOptionToken(["--dev"], 0)).toBe(1);
    expect(consumeRootOptionToken(["--profile=work"], 0)).toBe(1);
    expect(consumeRootOptionToken(["--log-level=debug"], 0)).toBe(1);
  });

  it("consumes split root value option only when next token is a value", () => {
    expect(consumeRootOptionToken(["--profile", "work"], 0)).toBe(2);
    expect(consumeRootOptionToken(["--profile", "--no-color"], 0)).toBe(1);
    expect(consumeRootOptionToken(["--profile", "--"], 0)).toBe(1);
  });
});
