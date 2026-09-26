import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { redactCredentialText, redactDiagnostic } from "./vitest/credential-redaction.ts";

describe("public test diagnostic redaction", () => {
  it.each([
    "EXAMPLE_TOKEN",
    "secret",
    "Password",
    "PASSWD",
    "API_KEY",
    "apiKey",
    "PRIVATE_KEY",
    "AUTHORIZATION",
    "COOKIE",
    "SESSION",
    "BLACKSMITH_STICKYDISK_TOKEN",
    "BLACKSMITH_CACHE_TOKEN",
    "BLACKSMITH_MONITORING_TOKEN",
    "BLACKSMITH_JOB_COMPLETION_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
  ])("preserves %s while hiding its value in object, JSON and env text", (key) => {
    const cases: [string, string][] = [
      [`${key}: 'synthetic'`, `${key}: '<redacted len=9>'`],
      [`${key}: "synthetic"`, `${key}: "<redacted len=9>"`],
      [`"${key}": "synthetic"`, `"${key}": "<redacted len=9>"`],
      [`${key}=synthetic\nNORMAL=visible`, `${key}=<redacted len=9>\nNORMAL=visible`],
      [`["${key}", "synthetic"]`, `["${key}", "<redacted len=9>"]`],
      [`[ '${key}', 'synthetic' ]`, `[ '${key}', '<redacted len=9>' ]`],
    ];
    for (const [input, expected] of cases) {
      expect(redactCredentialText(input)).toBe(expected);
      expect(redactCredentialText(expected)).toBe(expected);
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

  it("redacts multiline and JSON-encoded credential entry pairs", () => {
    const text = `+ [\n+   "EXAMPLE_TOKEN",\n+   "one\\ntwo",\n+ ],\n  ["NORMAL", "visible"]`;
    const clean = `+ [\n+   "EXAMPLE_TOKEN",\n+   "<redacted len=7>",\n+ ],\n  ["NORMAL", "visible"]`;
    expect(redactCredentialText(text)).toBe(clean);
    expect(redactCredentialText(clean)).toBe(clean);
    expect(redactCredentialText(`@@ -3,8 +3,8 @@\n  "EXAMPLE_TOKEN",\n  "synthetic",\n],`)).toBe(
      `@@ -3,8 +3,8 @@\n  "EXAMPLE_TOKEN",\n  "<redacted len=9>",\n],`,
    );
    const encoded = JSON.stringify({
      message: `[["EXAMPLE_TOKEN", "synthetic"], ["NORMAL", "visible"]]`,
    });
    expect(JSON.parse(redactCredentialText(encoded))).toEqual({
      message: `[["EXAMPLE_TOKEN", "<redacted len=9>"], ["NORMAL", "visible"]]`,
    });
  });

  it("handles escaped quotes, newlines, ANSI colors and repeated fields", () => {
    const text = `- "TO\u001b[31mKEN\u001b[0m": "one\\"two\\nthree",\n+ '\u001b[31mAPI_KEY\u001b[0m': 'a\\'b',\nNORMAL: 'visible'`;
    expect(redactCredentialText(text)).toBe(
      `- "TOKEN": "<redacted len=13>",\n+ 'API_KEY': '<redacted len=3>',\nNORMAL: 'visible'`,
    );
    expect(redactCredentialText("Authorization: Bearer synthetic\nCookie: a=b; c=d")).toBe(
      "Authorization: <redacted len=16>\nCookie: <redacted len=8>",
    );
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

  it("redacts credential objects embedded in JSON-encoded diagnostic strings", () => {
    let text = JSON.stringify({ EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" });
    for (let depth = 0; depth < 3; depth += 1) {
      text = JSON.stringify({ payload: text });
      const output = redactCredentialText(text);
      expect(output).toContain("<redacted len=9>");
      expect(output).toContain("visible");
      expect(output).not.toContain("synthetic");
    }
    for (const prefix of ["", "can't load "]) {
      const report = JSON.stringify({
        message: `${prefix}AUTHORIZATION=Bearer synthetic`,
        untouched: "visible",
      });
      expect(JSON.parse(redactCredentialText(report))).toEqual({
        message: `${prefix}AUTHORIZATION=<redacted len=16>`,
        untouched: "visible",
      });
    }
    expect(redactCredentialText('TOKEN: "SECRET=synthetic"')).toBe('TOKEN: "<redacted len=16>"');
  });

  it.each([
    ["AUTHORIZATION", "Bearer synthetic"],
    ["COOKIE", "first=synthetic; second=synthetic"],
    ["PASSWORD", "two synthetic words"],
    ["PASSWORD", " two synthetic words "],
    ["TOKEN", "synthetic NORMAL=visible"],
    ["TOKEN", "synthetic,second}"],
    ["TOKEN", "<redacted len=3> synthetic"],
  ])("redacts the complete unquoted %s environment value %s", (key, value) => {
    const output = redactCredentialText(`${key}=${value}\r\nNORMAL=visible`);
    expect(output).toBe(`${key}=<redacted len=${value.length}>\r\nNORMAL=visible`);
    expect(redactCredentialText(output)).toBe(output);
  });

  it("preserves empty environment records and independent object fields", () => {
    expect(redactCredentialText("TOKEN=\nNORMAL=visible")).toBe(
      "TOKEN=<redacted len=0>\nNORMAL=visible",
    );
    const object = '{ TOKEN: undefined, NORMAL: "visible" }';
    const clean = '{ TOKEN: <redacted len=9>, NORMAL: "visible" }';
    expect(redactCredentialText(object)).toBe(clean);
    expect(redactCredentialText(clean)).toBe(clean);
    const header = "Digest first=synthetic, second=synthetic";
    expect(redactCredentialText(`Authorization: ${header}`)).toBe(
      `Authorization: <redacted len=${header.length}>`,
    );
    expect(redactCredentialText('- "TOKEN": "first"\n+ "TOKEN": "second"')).toBe(
      '- "TOKEN": "<redacted len=5>"\n+ "TOKEN": "<redacted len=6>"',
    );
  });

  it("redacts all multiline credential fragments in native assertion messages", () => {
    const fragment = "not-a-real-secret-value-1234567890";
    const value = `-----BEGIN PRIVATE KEY-----\n${`${fragment}\n`.repeat(3)}-----END PRIVATE KEY-----`;
    let message = "";
    try {
      assert.deepStrictEqual({ PRIVATE_KEY: value }, {});
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    const output = redactCredentialText(message);
    expect(output.includes(fragment)).toBe(false);
    expect(output).toContain(`<redacted len=${value.length}>`);
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
