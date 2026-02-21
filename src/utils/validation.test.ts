import { describe, expect, it } from "vitest";
import {
  validateAll,
  validateEmail,
  validateLength,
  validateMaxLength,
  validateMinLength,
  validateNonEmpty,
  validateNumberRange,
  validateOneOf,
  validatePattern,
  validatePositiveInteger,
  validateUrl,
} from "./validation.js";

describe("validateNonEmpty", () => {
  it("accepts non-empty strings", () => {
    expect(validateNonEmpty("hello")).toEqual({ valid: true, value: "hello" });
    expect(validateNonEmpty("  hello  ")).toEqual({ valid: true, value: "hello" });
  });

  it("rejects empty strings", () => {
    expect(validateNonEmpty("")).toEqual({ valid: false, error: "Field cannot be empty" });
    expect(validateNonEmpty("   ")).toEqual({ valid: false, error: "Field cannot be empty" });
  });

  it("rejects non-strings", () => {
    expect(validateNonEmpty(123)).toEqual({ valid: false, error: "Field must be a string" });
    expect(validateNonEmpty(null)).toEqual({ valid: false, error: "Field must be a string" });
  });

  it("uses custom field name", () => {
    expect(validateNonEmpty("", "Username")).toEqual({
      valid: false,
      error: "Username cannot be empty",
    });
  });
});

describe("validatePattern", () => {
  it("accepts matching strings", () => {
    const result = validatePattern("abc123", /^[a-z0-9]+$/, "Invalid format");
    expect(result).toEqual({ valid: true, value: "abc123" });
  });

  it("rejects non-matching strings", () => {
    const result = validatePattern("ABC", /^[a-z0-9]+$/, "Invalid format");
    expect(result).toEqual({ valid: false, error: "Invalid format" });
  });

  it("rejects non-strings", () => {
    const result = validatePattern(123, /^[a-z]+$/, "Invalid format");
    expect(result).toEqual({ valid: false, error: "Invalid format" });
  });
});

describe("validateMinLength", () => {
  it("accepts strings meeting minimum length", () => {
    expect(validateMinLength("hello", 3)).toEqual({ valid: true, value: "hello" });
    expect(validateMinLength("hi", 2)).toEqual({ valid: true, value: "hi" });
  });

  it("rejects strings below minimum length", () => {
    expect(validateMinLength("hi", 3)).toEqual({
      valid: false,
      error: "Field must be at least 3 characters",
    });
  });

  it("handles singular form correctly", () => {
    expect(validateMinLength("", 1)).toEqual({
      valid: false,
      error: "Field must be at least 1 character",
    });
  });
});

describe("validateMaxLength", () => {
  it("accepts strings within maximum length", () => {
    expect(validateMaxLength("hello", 10)).toEqual({ valid: true, value: "hello" });
  });

  it("rejects strings exceeding maximum length", () => {
    expect(validateMaxLength("hello world", 5)).toEqual({
      valid: false,
      error: "Field must be at most 5 characters",
    });
  });

  it("handles singular form correctly", () => {
    expect(validateMaxLength("ab", 1)).toEqual({
      valid: false,
      error: "Field must be at most 1 character",
    });
  });
});

describe("validateLength", () => {
  it("accepts strings within range", () => {
    expect(validateLength("hello", 3, 10)).toEqual({ valid: true, value: "hello" });
  });

  it("rejects strings below minimum", () => {
    expect(validateLength("hi", 3, 10)).toEqual({
      valid: false,
      error: "Field must be at least 3 characters",
    });
  });

  it("rejects strings above maximum", () => {
    expect(validateLength("hello world", 3, 5)).toEqual({
      valid: false,
      error: "Field must be at most 5 characters",
    });
  });
});

describe("validateEmail", () => {
  it("accepts valid email addresses", () => {
    expect(validateEmail("test@example.com")).toEqual({
      valid: true,
      value: "test@example.com",
    });
    expect(validateEmail("user.name+tag@example.co.uk")).toEqual({
      valid: true,
      value: "user.name+tag@example.co.uk",
    });
  });

  it("rejects invalid email addresses", () => {
    expect(validateEmail("notanemail")).toEqual({
      valid: false,
      error: "Email must be a valid email address",
    });
    expect(validateEmail("@example.com")).toEqual({
      valid: false,
      error: "Email must be a valid email address",
    });
    expect(validateEmail("test@")).toEqual({
      valid: false,
      error: "Email must be a valid email address",
    });
  });

  it("rejects non-strings", () => {
    expect(validateEmail(123)).toEqual({
      valid: false,
      error: "Email must be a valid email address",
    });
  });
});

describe("validateUrl", () => {
  it("accepts valid http/https URLs", () => {
    expect(validateUrl("https://example.com")).toEqual({
      valid: true,
      value: "https://example.com",
    });
    expect(validateUrl("http://localhost:3000")).toEqual({
      valid: true,
      value: "http://localhost:3000",
    });
  });

  it("rejects non-http/https protocols", () => {
    expect(validateUrl("javascript:alert(1)")).toEqual({
      valid: false,
      error: "URL must use http or https protocol",
    });
    expect(validateUrl("data:text/html,<script>alert(1)</script>")).toEqual({
      valid: false,
      error: "URL must use http or https protocol",
    });
    expect(validateUrl("file:///etc/passwd")).toEqual({
      valid: false,
      error: "URL must use http or https protocol",
    });
  });

  it("rejects invalid URLs", () => {
    expect(validateUrl("not a url")).toEqual({
      valid: false,
      error: "URL must be a valid URL",
    });
    expect(validateUrl("example.com")).toEqual({
      valid: false,
      error: "URL must be a valid URL",
    });
  });

  it("rejects non-strings", () => {
    expect(validateUrl(123)).toEqual({
      valid: false,
      error: "URL must be a string",
    });
  });
});

describe("validateOneOf", () => {
  it("accepts valid options", () => {
    const options = ["red", "green", "blue"] as const;
    expect(validateOneOf("red", options)).toEqual({ valid: true, value: "red" });
    expect(validateOneOf("green", options)).toEqual({ valid: true, value: "green" });
  });

  it("rejects invalid options", () => {
    const options = ["red", "green", "blue"] as const;
    expect(validateOneOf("yellow", options)).toEqual({
      valid: false,
      error: 'Field must be one of: "red", "green", "blue"',
    });
  });

  it("rejects non-strings", () => {
    const options = ["red", "green"] as const;
    expect(validateOneOf(123, options)).toEqual({
      valid: false,
      error: "Field must be a string",
    });
  });
});

describe("validateAll", () => {
  it("passes when all validators pass", () => {
    const result = validateAll("hello", [
      (v) => validateNonEmpty(v),
      (v) => validateMinLength(v, 3),
    ]);
    expect(result).toEqual({ valid: true, value: "hello" });
  });

  it("fails on first validator that fails", () => {
    const result = validateAll("hi", [
      (v) => validateNonEmpty(v),
      (v) => validateMinLength(v, 5),
      (v) => validateMaxLength(v, 10),
    ]);
    expect(result).toEqual({
      valid: false,
      error: "Field must be at least 5 characters",
    });
  });

  it("passes with no validators", () => {
    const result = validateAll("hello", []);
    expect(result).toEqual({ valid: true, value: "hello" });
  });
});

describe("validateNumberRange", () => {
  it("accepts numbers within range", () => {
    expect(validateNumberRange(5, 1, 10)).toEqual({ valid: true, value: 5 });
    expect(validateNumberRange(1, 1, 10)).toEqual({ valid: true, value: 1 });
    expect(validateNumberRange(10, 1, 10)).toEqual({ valid: true, value: 10 });
  });

  it("rejects numbers outside range", () => {
    expect(validateNumberRange(0, 1, 10)).toEqual({
      valid: false,
      error: "Number must be between 1 and 10",
    });
    expect(validateNumberRange(11, 1, 10)).toEqual({
      valid: false,
      error: "Number must be between 1 and 10",
    });
  });

  it("rejects non-numbers", () => {
    expect(validateNumberRange("5", 1, 10)).toEqual({
      valid: false,
      error: "Number must be a finite number",
    });
    expect(validateNumberRange(NaN, 1, 10)).toEqual({
      valid: false,
      error: "Number must be a finite number",
    });
    expect(validateNumberRange(Infinity, 1, 10)).toEqual({
      valid: false,
      error: "Number must be a finite number",
    });
  });
});

describe("validatePositiveInteger", () => {
  it("accepts positive integers", () => {
    expect(validatePositiveInteger(1)).toEqual({ valid: true, value: 1 });
    expect(validatePositiveInteger(100)).toEqual({ valid: true, value: 100 });
  });

  it("rejects zero", () => {
    expect(validatePositiveInteger(0)).toEqual({
      valid: false,
      error: "Number must be a positive integer",
    });
  });

  it("rejects negative numbers", () => {
    expect(validatePositiveInteger(-1)).toEqual({
      valid: false,
      error: "Number must be a positive integer",
    });
  });

  it("rejects non-integers", () => {
    expect(validatePositiveInteger(1.5)).toEqual({
      valid: false,
      error: "Number must be an integer",
    });
  });

  it("rejects non-numbers", () => {
    expect(validatePositiveInteger("1")).toEqual({
      valid: false,
      error: "Number must be an integer",
    });
  });
});
