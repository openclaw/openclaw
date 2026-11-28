import { expect, it } from "vitest";
import { isCredentialEnvName } from "./vitest/credential-env-name.ts";
import { redactCredentialText, redactDiagnostic } from "./vitest/credential-redaction.ts";

it("recognizes credential env names without hiding ordinary key fields", () => {
  for (const name of `FAL_KEY AZURE_SPEECH_KEY BYTEPLUS_ACCESS_KEY_ID
      OPENCLAW_LIVE_R2_SECRET_ACCESS_KEY OPENCLAW_CLAUDE_CREDENTIALS_JSON
      OPENCLAW_CODEX_AUTH_JSON CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN OPENAI_API_KEY
      APIKEY SOME_APIKEY EXAMPLE_KEYS EXAMPLE_CREDENTIAL EXAMPLE_TOKEN PASSWORD SESSION_COOKIE`.split(
    /\s+/u,
  )) {
    expect(isCredentialEnvName(name), name).toBe(true);
  }
  for (const name of `key cacheKey primaryKey keys sortKey apiKey SOMEAPIKEY
      DBUS_SESSION_BUS_ADDRESS XDG_SESSION_ID TERM_SESSION_ID SSH_AUTH_SOCK
      MONKEY_PATCH KEYBOARD_LAYOUT PATH HOME fal_key Example_CREDENTIAL`.split(/\s+/u)) {
    expect(isCredentialEnvName(name), name).toBe(false);
  }
});
const encodedObject = JSON.stringify({ EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" });
const encodedClean = JSON.stringify({ EXAMPLE_TOKEN: "<redacted len=9>", NORMAL: "visible" });
const wrap = (input: string) =>
  [1, 2, 3].reduce((value) => JSON.stringify({ payload: value }), input);
const redactedCase = (input: string, secret = "synthetic"): [string, string] => [
  input,
  input.replaceAll(secret, `<redacted len=${secret.length}>`),
];
it("redacts credential text without altering nonsecret fields", () => {
  const cases: [string, string][] = [
    ...[
      "EXAMPLE_TOKEN: 'synthetic'",
      'PASSWD: "synthetic"',
      '"FAL_KEY": "synthetic"',
      "OPENCLAW_CODEX_AUTH_JSON=synthetic\nNORMAL=visible",
      '["apiKey", "synthetic"]',
      "[ 'sessionId', 'synthetic' ]",
    ].map((input) => redactedCase(input)),
    [
      `+ [\n+   "EXAMPLE_TOKEN",\n+   "one\\ntwo",\n+ ],\n  ["NORMAL", "visible"]`,
      `+ [\n+   "EXAMPLE_TOKEN",\n+   "<redacted len=7>",\n+ ],\n  ["NORMAL", "visible"]`,
    ],
    redactedCase(`@@ -3,8 +3,8 @@\n  "EXAMPLE_TOKEN",\n  "synthetic",\n],`),
    redactedCase(
      JSON.stringify({ message: `[["EXAMPLE_TOKEN", "synthetic"], ["NORMAL", "visible"]]` }),
    ),
    [
      `- "TO\u001b[31mKEN\u001b[0m": "one\\"two\\nthree",\n+ '\u001b[31mAPI_KEY\u001b[0m': 'a\\'b',\nNORMAL: 'visible'`,
      `- "TOKEN": "<redacted len=13>",\n+ 'API_KEY': '<redacted len=3>',\nNORMAL: 'visible'`,
    ],
    [
      "Authorization: Bearer synthetic\nCookie: a=b; c=d",
      "Authorization: <redacted len=16>\nCookie: <redacted len=8>",
    ],
    [wrap(encodedObject), wrap(encodedClean)],
    redactedCase(
      JSON.stringify({
        message: "can't load AUTHORIZATION=Bearer synthetic",
        untouched: "visible",
      }),
      "Bearer synthetic",
    ),
    redactedCase('TOKEN: "SECRET=synthetic"', "SECRET=synthetic"),
    redactedCase(
      "TOKEN= <redacted len=3> synthetic NORMAL=visible,second} \r\nNORMAL=visible",
      " <redacted len=3> synthetic NORMAL=visible,second} ",
    ),
    ["TOKEN=\nNORMAL=visible", "TOKEN=<redacted len=0>\nNORMAL=visible"],
    ['{ TOKEN: undefined, NORMAL: "visible" }', '{ TOKEN: <redacted len=9>, NORMAL: "visible" }'],
  ];
  for (const [input, expected] of cases) {
    expect(redactCredentialText(input), input).toBe(expected);
    expect(redactCredentialText(expected), input).toBe(expected);
  }
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
});

it("scrubs every error field and nested causes without losing nonsecret diagnostics", () => {
  const error = Object.assign(new Error("TOKEN=synthetic"), {
    diff: "PASSWORD: 'synthetic'",
    expected: '"API_KEY": "synthetic"',
    actual: {
      env: { EXAMPLE_TOKEN: "synthetic", NORMAL: "visible" },
      entries: [
        ["apiKey", "synthetic", "retained"],
        ["NORMAL", "visible"],
      ],
      TOKEN: ["first", "second"],
    },
    frame: "COOKIE=synthetic",
    codeFrame: "SESSION=synthetic",
    cause: { message: "SECRET=synthetic" },
  });
  Object.assign(error.cause, { parent: error });
  redactDiagnostic(error);
  const once = error.message;
  redactDiagnostic(error);
  expect(error.message).toBe(once);
  for (const field of ["message", "stack", "diff", "expected", "frame", "codeFrame"] as const) {
    const value = error[field];
    expect(value).toContain("<redacted len=9>");
    expect(value).not.toContain("synthetic");
  }
  expect(error.actual.env).toEqual({ EXAMPLE_TOKEN: "<redacted len=9>", NORMAL: "visible" });
  expect(error.actual.entries).toEqual([
    ["apiKey", "<redacted len=9>", "retained"],
    ["NORMAL", "visible"],
  ]);
  expect(error.actual.TOKEN).toEqual(expect.stringMatching(/^<redacted len=\d+>$/u));
  expect(error.cause.message).toBe("SECRET=<redacted len=9>");
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
