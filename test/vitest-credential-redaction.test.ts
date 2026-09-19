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

  it.each([
    "    at /workspace/model-fallback.session-identity.test.ts:48:40",
    "    at test/session.test.ts:76:58",
    "    at session.test.ts:48:40",
    "    at async session.test.ts:48:40",
    "    at Object.run (/workspace/token.test.mts:12:3)",
    "    at Object.run(/workspace/token.test.mts:12:3)",
    "    at run (C:\\workspace\\api_key.spec.cts:3:5)",
    "    at C:\\workspace\\password.test.cjs:12:4",
    "    at run (file:///workspace/(tests)/cookie.test.mjs:2:6)",
    " \u276f test/model-fallback.session-identity.test.ts:48:40",
    " \u276f Object.run test/session.test.ts:76:58",
    " \u276f Object.run session.test.ts:76:58",
    " \u276f /workspace/private_key.test.jsx:10:12",
    " \u276f /workspace/authorization.test.tsx:10:12",
    "    at /workspace/secret.js:12:3",
    "    at /workspace/PASSWD.test.ts:12:3",
  ])("preserves the source location in %s", (frame) => {
    expect(redactCredentialText(frame)).toBe(frame);
    expect(redactCredentialText(redactCredentialText(frame))).toBe(frame);
  });

  it("preserves colored, CRLF and JSON-encoded source locations", () => {
    const frame = " \u276f test/session.test.ts:48:40\r\n    at /workspace/token.test.ts:76:58";
    expect(redactCredentialText(frame.replace("48:40", "\u001b[2m48:40\u001b[22m"))).toBe(frame);
    let encoded = frame;
    for (let depth = 0; depth < 3; depth += 1) {
      encoded = JSON.stringify({ message: encoded });
      expect(redactCredentialText(encoded)).toBe(encoded);
    }
    const error = { stack: frame, cause: { stack: frame } };
    redactDiagnostic(error);
    expect(error).toEqual({ stack: frame, cause: { stack: frame } });
  });

  it.each([
    "SESSION=48:40",
    "SESSION:48:40",
    "settings.SESSION:48:40",
    "at SESSION:48:40",
    "at settings.SESSION:48:40",
    " \u276f settings.SESSION:48:40",
    "session.test.ts:48:40",
    '"session.test.ts":48:40',
    "'session.test.ts':48:40",
    'at "session.test.ts":48:40',
    ' \u276f "session.test.ts":48:40',
    "at session.test.ts=48:40",
    "at session.test.ts :48:40",
    "at session.txt:48:40",
    "at session.test.ts:48:40)",
    "at run (session.test.ts:48:40",
    "at session.test.ts:48:40 trailing text",
    "prefix at session.test.ts:48:40",
  ])("does not exempt the credential assignment in %s", (input) => {
    const output = redactCredentialText(input);
    expect(output).toContain("<redacted len=");
    expect(output).not.toContain("48:40");
    expect(redactCredentialText(output)).toBe(output);
  });

  it.each([
    "SESSION=synthetic\n    at /workspace/session.test.ts:48:40",
    "SESSION: 'synthetic' at /workspace/session.test.ts:48:40",
    "    at run (TOKEN=synthetic/session.test.ts:48:40)",
    "    at run (/TOKEN:synthetic/session.test.ts:48:40)",
    "    at run (https://SESSION:synthetic@example.test/session.test.ts:48:40)",
    "    at run (file:///workspace/session.test.ts?TOKEN=synthetic:48:40)",
    "    at run (/workspace/session.test.ts:48:40) TOKEN=synthetic",
    " \u276f session.test.ts:48:40 TOKEN=synthetic",
  ])("redacts real credentials beside source locations in %s", (input) => {
    const output = redactCredentialText(input);
    expect(output).toContain("<redacted len=");
    expect(output).not.toContain("synthetic");
    expect(redactCredentialText(output)).toBe(output);
  });

  it("does not exempt stack-looking values of credential fields or entry pairs", () => {
    const frame = "    at /workspace/session.test.ts:48:40";
    const marker = `<redacted len=${frame.length}>`;
    for (const key of ["SESSION", "session.test.ts"]) {
      expect(redactCredentialText(`${key}: ${JSON.stringify(frame)}`)).toBe(`${key}: "${marker}"`);
      expect(redactCredentialText(`${key}=${frame}`)).toBe(`${key}=${marker}`);
      const diagnostic = { [key]: frame, cause: { entries: [[key, frame]], stack: frame } };
      redactDiagnostic(diagnostic);
      expect(diagnostic).toEqual({
        [key]: marker,
        cause: { entries: [[key, marker]], stack: frame },
      });
      const encoded = JSON.stringify({ payload: JSON.stringify({ [key]: frame }) });
      expect(JSON.parse(redactCredentialText(encoded))).toEqual({
        payload: JSON.stringify({ [key]: marker }),
      });
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
