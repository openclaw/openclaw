import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../plugin-sdk/security-runtime.js";
import { redactInputTextWithSourcePolicy, redactText } from "./redact.js";

describe("nested redaction calls", () => {
  it.each([false, true])(
    "keeps nested matcher input and pattern order (fullContext=%s)",
    (fullContext) => {
      const inputs: string[] = [];
      const nested: string[] = [];
      const matcher = {
        source: "bracketed fixture values",
        *exec(input: string) {
          inputs.push(input);
          for (const match of input.matchAll(/\[(outer-[a-z]+)\]/g)) {
            nested.push(redactSensitiveText("inside private", { patterns: [/private/g] }));
            yield { match: match[0], groups: [match[1] ?? ""], input, offset: match.index };
          }
        },
      };

      const input = "prefix [outer-one] [outer-two] suffix";
      const patterns = [/prefix/g, matcher, /suffix/g];
      expect(
        fullContext
          ? redactText(input, patterns, { fullContext })
          : redactSensitiveText(input, { patterns }),
      ).toBe("*** [***] [***] ***");
      expect(inputs).toEqual(["*** [outer-one] [outer-two] suffix"]);
      expect(nested).toEqual(["inside ***", "inside ***"]);
    },
  );

  it("keeps each source assignment policy active after it performs nested redaction", () => {
    const input = "API_TOKEN=computeFirst()\nAPI_TOKEN=computeSecond()";
    const assignments: string[] = [];

    expect(
      redactInputTextWithSourcePolicy(input, undefined, (text, offset) => {
        expect(redactSensitiveText("inside private", { patterns: [/private/g] })).toBe(
          "inside ***",
        );
        assignments.push(text.slice(offset).split("\n")[0] ?? "");
        return true;
      }),
    ).toBe(input);
    expect(assignments).toEqual(expect.arrayContaining(["computeFirst()", "computeSecond()"]));
  });
});
