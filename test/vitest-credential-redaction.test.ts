import { describe, expect, it } from "vitest";
import { redactCredentialText, redactDiagnostic } from "./vitest/credential-redaction.ts";

describe("public test diagnostic redaction", () => {
  const encodedObject = JSON.stringify({ EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" });
  const encodedClean = JSON.stringify({ EXAMPLE_TOKEN: "<redacted len=9>", NORMAL: "visible" });
  const wrap = (input: string, depth: number) => {
    let value = input;
    for (let index = 0; index < depth; index++) {
      value = JSON.stringify({ payload: value });
    }
    return value;
  };
  it("redacts credential text without altering nonsecret fields", () => {
    const cases: [string, string][] = [
      ...["EXAMPLE_TOKEN", "PASSWD"].flatMap((key): [string, string][] => [
        [`${key}: 'synthetic'`, `${key}: '<redacted len=9>'`],
        [`${key}: "synthetic"`, `${key}: "<redacted len=9>"`],
        [`"${key}": "synthetic"`, `"${key}": "<redacted len=9>"`],
        [`${key}=synthetic\nNORMAL=visible`, `${key}=<redacted len=9>\nNORMAL=visible`],
        [`["${key}", "synthetic"]`, `["${key}", "<redacted len=9>"]`],
        [`[ '${key}', 'synthetic' ]`, `[ '${key}', '<redacted len=9>' ]`],
      ]),
      [
        `+ [\n+   "EXAMPLE_TOKEN",\n+   "one\\ntwo",\n+ ],\n  ["NORMAL", "visible"]`,
        `+ [\n+   "EXAMPLE_TOKEN",\n+   "<redacted len=7>",\n+ ],\n  ["NORMAL", "visible"]`,
      ],
      [
        `@@ -3,8 +3,8 @@\n  "EXAMPLE_TOKEN",\n  "synthetic",\n],`,
        `@@ -3,8 +3,8 @@\n  "EXAMPLE_TOKEN",\n  "<redacted len=9>",\n],`,
      ],
      [
        JSON.stringify({ message: `[["EXAMPLE_TOKEN", "synthetic"], ["NORMAL", "visible"]]` }),
        JSON.stringify({
          message: `[["EXAMPLE_TOKEN", "<redacted len=9>"], ["NORMAL", "visible"]]`,
        }),
      ],
      [
        `- "TO\u001b[31mKEN\u001b[0m": "one\\"two\\nthree",\n+ '\u001b[31mAPI_KEY\u001b[0m': 'a\\'b',\nNORMAL: 'visible'`,
        `- "TOKEN": "<redacted len=13>",\n+ 'API_KEY': '<redacted len=3>',\nNORMAL: 'visible'`,
      ],
      [
        "Authorization: Bearer synthetic\nCookie: a=b; c=d",
        "Authorization: <redacted len=16>\nCookie: <redacted len=8>",
      ],
      ...[1, 2, 3].map((depth): [string, string] => [
        wrap(encodedObject, depth),
        wrap(encodedClean, depth),
      ]),
      ...["", "can't load "].map((prefix): [string, string] => [
        JSON.stringify({
          message: `${prefix}AUTHORIZATION=Bearer synthetic`,
          untouched: "visible",
        }),
        JSON.stringify({
          message: `${prefix}AUTHORIZATION=<redacted len=16>`,
          untouched: "visible",
        }),
      ]),
      ['TOKEN: "SECRET=synthetic"', 'TOKEN: "<redacted len=16>"'],
      ...(
        [
          ["PASSWORD", " two synthetic words "],
          ["TOKEN", "synthetic NORMAL=visible"],
          ["TOKEN", "synthetic,second}"],
          ["TOKEN", "<redacted len=3> synthetic"],
        ] satisfies [string, string][]
      ).map(([key, value]): [string, string] => [
        `${key}=${value}\r\nNORMAL=visible`,
        `${key}=<redacted len=${value.length}>\r\nNORMAL=visible`,
      ]),
      ["TOKEN=\nNORMAL=visible", "TOKEN=<redacted len=0>\nNORMAL=visible"],
      ['{ TOKEN: undefined, NORMAL: "visible" }', '{ TOKEN: <redacted len=9>, NORMAL: "visible" }'],
      [
        "Authorization: Digest first=synthetic, second=synthetic",
        "Authorization: <redacted len=40>",
      ],
      [
        '- "TOKEN": "first"\n+ "TOKEN": "second"',
        '- "TOKEN": "<redacted len=5>"\n+ "TOKEN": "<redacted len=6>"',
      ],
    ];
    for (const [input, expected] of cases) {
      expect(redactCredentialText(input), input).toBe(expected);
      expect(redactCredentialText(expected), input).toBe(expected);
    }
  });

  it("scrubs nested credential entry pairs while preserving keys and ordinary entries", () => {
    const diagnostic = {
      actual: { env: Object.entries({ EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" }) },
      cause: {
        entries: [
          ["apiKey", "synthetic", "retained"],
          ["NORMAL", "visible"],
        ],
      },
    };
    redactDiagnostic(diagnostic);
    const expected = {
      actual: {
        env: [
          ["EXAMPLE_TOKEN", "<redacted len=9>"],
          ["NORMAL", "visible"],
        ],
      },
      cause: {
        entries: [
          ["apiKey", "<redacted len=9>", "retained"],
          ["NORMAL", "visible"],
        ],
      },
    };
    expect(diagnostic).toEqual(expected);
    redactDiagnostic(diagnostic);
    expect(diagnostic).toEqual(expected);
  });

  it("redacts composite values and strings that merely start with a redaction marker", () => {
    for (const input of [
      `TOKEN: ['first', { nested: 'second' }]`,
      "TOKEN: `first, second`",
      `TOKEN: '<redacted len=3>synthetic'`,
      `TOKEN=<redacted len=3>synthetic`,
    ]) {
      const output = redactCredentialText(input);
      expect(output).toMatch(/^TOKEN[:=]\s*["'`]?<redacted len=\d+>["'`]?$/u);
      expect(output).not.toMatch(/first|second|synthetic/u);
      expect(redactCredentialText(output)).toBe(output);
    }
    const object = { TOKEN: ["first", "second"] };
    redactDiagnostic(object);
    expect(object.TOKEN).toEqual(expect.stringMatching(/^<redacted len=\d+>$/u));
  });

  it("scrubs every error field and nested causes without losing nonsecret diagnostics", () => {
    const error = Object.assign(new Error("TOKEN=synthetic"), {
      diff: "PASSWORD: 'synthetic'",
      expected: '"API_KEY": "synthetic"',
      actual: { env: { EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" } },
      frame: "COOKIE=synthetic",
      codeFrame: "SESSION=synthetic",
      cause: { message: "SECRET=synthetic" },
    });
    Object.assign(error.cause, { parent: error });
    redactDiagnostic(error);
    const once = error.message;
    redactDiagnostic(error);
    expect(error.message).toBe(once);
    for (const value of [
      error.message,
      error.stack,
      error.diff,
      error.expected,
      error.frame,
      error.codeFrame,
    ]) {
      expect(value).toContain("<redacted len=9>");
      expect(value).not.toContain("synthetic");
    }
    expect(error.actual.env).toEqual({ EXAMPLE_TOKEN: "<redacted len=9>", NORMAL: "visible" });
    expect(error.cause.message).toBe("SECRET=<redacted len=9>");
  });
});
