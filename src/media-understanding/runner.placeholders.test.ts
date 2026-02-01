import { describe, it, expect } from "vitest";

/**
 * Legacy placeholder aliases for CLI args.
 * Maps intuitive single-brace placeholders to standard double-brace format.
 */
const LEGACY_PLACEHOLDER_MAP: Record<string, string> = {
  "{file}": "{{MediaPath}}",
  "{input}": "{{MediaPath}}",
  "{media}": "{{MediaPath}}",
  "{output}": "{{OutputDir}}",
  "{output_dir}": "{{OutputDir}}",
  "{output_base}": "{{OutputBase}}",
  "{prompt}": "{{Prompt}}",
  "{media_dir}": "{{MediaDir}}",
};

/**
 * Normalize legacy single-brace placeholders to standard double-brace format.
 * Supports case-insensitive matching for convenience.
 */
function normalizePlaceholders(value: string): string {
  let result = value;
  for (const [legacy, standard] of Object.entries(LEGACY_PLACEHOLDER_MAP)) {
    // Case-insensitive replacement
    const pattern = new RegExp(legacy.replace(/[{}]/g, "\\$&"), "gi");
    result = result.replace(pattern, standard);
  }
  return result;
}

describe("normalizePlaceholders", () => {
  it("should convert {file} to {{MediaPath}}", () => {
    expect(normalizePlaceholders("{file}")).toBe("{{MediaPath}}");
  });

  it("should convert {FILE} case-insensitively", () => {
    expect(normalizePlaceholders("{FILE}")).toBe("{{MediaPath}}");
  });

  it("should convert {File} mixed case", () => {
    expect(normalizePlaceholders("{File}")).toBe("{{MediaPath}}");
  });

  it("should handle {input} as MediaPath alias", () => {
    expect(normalizePlaceholders("{input}")).toBe("{{MediaPath}}");
  });

  it("should handle {output} as OutputDir alias", () => {
    expect(normalizePlaceholders("{output}")).toBe("{{OutputDir}}");
  });

  it("should handle {output_dir} as OutputDir alias", () => {
    expect(normalizePlaceholders("{output_dir}")).toBe("{{OutputDir}}");
  });

  it("should handle {prompt} as Prompt alias", () => {
    expect(normalizePlaceholders("{prompt}")).toBe("{{Prompt}}");
  });

  it("should preserve already-correct {{MediaPath}} format", () => {
    expect(normalizePlaceholders("{{MediaPath}}")).toBe("{{MediaPath}}");
  });

  it("should work with mixed content", () => {
    const input = "--input {file} --output {output}";
    const expected = "--input {{MediaPath}} --output {{OutputDir}}";
    expect(normalizePlaceholders(input)).toBe(expected);
  });

  it("should handle real whisper CLI args", () => {
    const args = ["{file}", "--model", "large-v3-turbo", "--output_dir", "/tmp"];
    const normalized = args.map(normalizePlaceholders);
    expect(normalized[0]).toBe("{{MediaPath}}");
    expect(normalized[1]).toBe("--model");
    expect(normalized[2]).toBe("large-v3-turbo");
  });

  it("should not modify unrelated content", () => {
    expect(normalizePlaceholders("--model turbo")).toBe("--model turbo");
    expect(normalizePlaceholders("/path/to/file.txt")).toBe("/path/to/file.txt");
  });
});
