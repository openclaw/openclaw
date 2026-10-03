import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { replacePatternBounded } from "./redact-bounded.js";
import { TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS } from "./redact-patterns.js";
import { redactSourceInputTextWithConfig } from "./redact-source.js";
import {
  captureSensitiveTextRedactionSnapshot,
  computeSensitiveRedactionBitmap,
  createSensitiveTextRedactor,
  getDefaultRedactPatterns,
  redactModelVisibleToolPayloadText,
  redactSecrets,
  redactSensitiveFieldValue,
  redactSensitiveLines,
  redactSensitiveText,
  redactToolPayloadTextWithConfig,
  resolveRedactOptions,
} from "./redact.js";
import { withFullContextToolPayloadRedaction } from "./redact.test-support.js";
import {
  redactRegisteredSecretValues,
  registerSecretValueForRedaction,
} from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

const defaults = getDefaultRedactPatterns();
let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-redact-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("bounded replacement output", () => {
  const firstChunk = "a".repeat(16_384);
  const remainingChunks = "b".repeat(16_384) + "c".repeat(16_384);
  it.each<[RegExp, string, string]>([
    [/none/g, "blue", firstChunk + remainingChunks],
    [/a+/g, "", remainingChunks],
  ])("preserves complete output for %s", (pattern, replacement, expected) => {
    expect(replacePatternBounded(firstChunk + remainingChunks, pattern, () => replacement)).toBe(
      expected,
    );
  });

  it("keeps calling a stateful replacer after unchanged results", () => {
    const calls: Array<{ match: string; offset: number; input: string }> = [];
    const chunk = "red" + " ".repeat(16_384 - 3);
    const output = replacePatternBounded(chunk + chunk + "red", /red/g, (match, offset, input) => {
      calls.push({ match, offset, input });
      return calls.length === 3 ? "blue" : match;
    });
    expect(output).toBe(chunk + chunk + "blue");
    expect(calls).toEqual([
      { match: "red", offset: 0, input: chunk },
      { match: "red", offset: 0, input: chunk },
      { match: "red", offset: 0, input: "red" },
    ]);
  });
});

describe("registered exact secret values", () => {
  it("shares registrations and matcher invalidation across module instances", async () => {
    const first = await import("./secret-redaction-registry.js");
    const firstSecret = "alpha-module-secret";
    const secondSecret = "zulu-module-secret";
    const text = `${firstSecret} ${secondSecret}`;
    const mask = () => "[redacted]";
    first.registerSecretValueForRedaction(firstSecret);
    expect(first.redactRegisteredSecretValues(text, mask)).toBe(`[redacted] ${secondSecret}`);

    // Re-evaluation models a second registry copy imported by bundled code.
    vi.resetModules();
    const second = await import("./secret-redaction-registry.js");
    expect(second.redactRegisteredSecretValues(text, mask)).toBe(`[redacted] ${secondSecret}`);
    const revision = first.getSecretRedactionRegistryRevision();
    second.registerSecretValueForRedaction(secondSecret);
    expect(first.redactRegisteredSecretValues(secondSecret, mask)).toBe("[redacted]");
    expect(first.redactRegisteredSecretValues(text, mask)).toBe("[redacted] [redacted]");
    expect(first.getSecretRedactionRegistryRevision()).toBeGreaterThan(revision);
    const captured = createSensitiveTextRedactor(captureSensitiveTextRedactionSnapshot());
    expect(captured(text)).toBe("alpha-…cret zulu-m…cret");
    const updatedRevision = first.getSecretRedactionRegistryRevision();
    second.registerSecretValueForRedaction(secondSecret);
    expect(first.getSecretRedactionRegistryRevision()).toBe(updatedRevision);

    resetSecretRedactionRegistryForTest();
    expect(first.redactRegisteredSecretValues(text, mask)).toBe(text);
    expect(second.redactRegisteredSecretValues(text, mask)).toBe(text);
    expect(first.getSecretRedactionRegistryRevision()).toBeGreaterThan(updatedRevision);
    expect(captured(text)).toBe("alpha-…cret zulu-m…cret");
    expect(createSensitiveTextRedactor(captureSensitiveTextRedactionSnapshot())(text)).toBe(text);
  });

  it("masks registered values in text and nested structured data", () => {
    const secret = "registered-exact-secret";
    registerSecretValueForRedaction(secret);

    expect(redactSensitiveText(`before ${secret} after`, { mode: "off" })).toBe(
      "before regist…cret after",
    );
    expect(redactSecrets({ detail: `before ${secret} after` })).toEqual({
      detail: "before regist…cret after",
    });
    expect(
      redactToolPayloadTextWithConfig(
        `full context ${secret}`,
        withFullContextToolPayloadRedaction(undefined),
      ),
    ).toBe("full context regist…cret");
  });

  it("ignores values shorter than six characters", () => {
    registerSecretValueForRedaction("abcde");
    expect(redactSensitiveText("value abcde", { mode: "off" })).toBe("value abcde");
    expect(redactSecrets({ detail: "abcde" })).toEqual({ detail: "abcde" });
  });

  it("refreshes duplicate registration recency before eviction", () => {
    const first = "exact-registry-refresh-000";
    const second = "exact-registry-refresh-001";
    for (let index = 0; index < 512; index += 1) {
      registerSecretValueForRedaction(
        `exact-registry-refresh-${index.toString().padStart(3, "0")}`,
      );
    }
    registerSecretValueForRedaction(first);
    registerSecretValueForRedaction("exact-registry-refresh-512");

    expect(redactSensitiveText(first, { mode: "off" })).not.toContain(first);
    expect(redactSensitiveText(second, { mode: "off" })).toBe(second);
  });

  it("keeps outer matches fixed when a mask callback registers another value", () => {
    const first = "first-exact-fixture";
    const second = "second-exact-fixture";
    registerSecretValueForRedaction(first);
    const input = `${first} ${second} ${first}`;
    const nested: string[] = [];

    const output = redactRegisteredSecretValues(input, () => {
      registerSecretValueForRedaction(second);
      nested.push(redactRegisteredSecretValues(input, () => "nested"));
      return "outer";
    });

    expect(output).toBe(`outer ${second} outer`);
    expect(nested).toEqual(["nested nested nested", "nested nested nested"]);
  });
});

describe("captured sensitive text redaction", () => {
  it("preserves exact surface forms, longest matches, and built-in masking after transfer", () => {
    const secret = 'opaque-fixture/"quoted"\nvalue';
    const encoded = encodeURIComponent(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    const doubleEncoded = encodeURIComponent(encoded);
    registerSecretValueForRedaction(secret);
    registerSecretValueForRedaction("overlap-fixture");
    registerSecretValueForRedaction("overlap-fixture-complete");
    const redact = createSensitiveTextRedactor(
      structuredClone(captureSensitiveTextRedactionSnapshot()),
    );
    resetSecretRedactionRegistryForTest();

    expect(
      redact(
        [
          secret,
          encoded,
          escaped,
          doubleEncoded,
          "overlap-fixture-complete overlap-fixture",
          "token=abcdef1234567890ghij",
        ].join("\n"),
      ),
    ).toBe(
      [
        "opaque…alue",
        "opaque…alue",
        "opaque…alue",
        doubleEncoded,
        "overla…lete ***",
        "token=abcdef…ghij",
      ].join("\n"),
    );
    expect(redactSensitiveText(secret, { mode: "off" })).toBe(secret);
  });
});

describe("model-visible tool payload redaction", () => {
  it.each([
    'const API_TOKEN = "fixture-only-not-a-real-secret"; return API_TOKEN;',
    "const API_TOKEN = `fixture-only-not-a-real-secret`; return API_TOKEN;",
    "const API_TOKEN = 987654321; return API_TOKEN;",
    "// API_TOKEN=fixture-only-not-a-real-secret\nreturn 42;",
    'const API_TOKEN = "fixture-only-not-a-real-secret"; @',
    '(token="fixture-only-not-a-real-secret");',
  ])("retains diagnostic literal masking in input source: %s", (source) => {
    const redacted = redactSourceInputTextWithConfig(source);
    expect(redactToolPayloadTextWithConfig(source)).not.toBe(source);
    expect(redacted).not.toMatch(/fixture-only-not-a-real-secret|987654321/);
    expect(redacted).toContain("***");
    expect(redacted).not.toBe(source);
    expect(redactSourceInputTextWithConfig(redacted)).toBe(redacted);
  });

  it.each([
    "const API_TOKEN = computeToken(); return API_TOKEN;",
    "const API_TOKEN = (40 + 2); return API_TOKEN;",
    "const API_TOKEN = await computeToken(); return API_TOKEN;",
    "const HAS_API_TOKEN = false; return HAS_API_TOKEN;",
    "let API_TOKEN = null; return API_TOKEN;",
  ])("preserves input computations without changing diagnostics: %s", (source) => {
    expect(redactSourceInputTextWithConfig(source)).toBe(source);
    expect(redactToolPayloadTextWithConfig(source)).not.toBe(source);
  });

  it("keeps explicit custom assignment patterns authoritative over source syntax", () => {
    const source = "const API_TOKEN = computeToken(); return API_TOKEN;";
    const assignmentPatterns = [...TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS].filter(
      (pattern) => redactSensitiveText(source, { patterns: [pattern] }) !== source,
    );
    expect(assignmentPatterns.length).toBeGreaterThan(0);
    for (const pattern of ["computeToken", ...assignmentPatterns]) {
      expect(redactSourceInputTextWithConfig(source, { redactPatterns: [pattern] })).not.toContain(
        "computeToken",
      );
    }
  });

  it("uses bounded diagnostic masking for oversized source", () => {
    const source = `const API_TOKEN = computeToken();\n${" ".repeat(131_072)}`;
    expect(redactSourceInputTextWithConfig(source)).toBe(redactToolPayloadTextWithConfig(source));
    expect(redactSourceInputTextWithConfig(source)).not.toContain("computeToken");
  });

  it("preserves source assignments while masking explicit credential forms", () => {
    const registeredSecret = "registered-model-visible-secret";
    registerSecretValueForRedaction(registeredSecret);
    const credentials = [
      registeredSecret,
      "bearer-model-visible-credential-1234567890",
      "url-model-visible-password-1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    ];
    const input = [
      "token = timeObserverToken",
      '"api_key": "computeToken()"',
      `registered: ${credentials[0]}`,
      `Authorization: Bearer ${credentials[1]}`,
      `https://user:${credentials[2]}@example.test/path`,
      `GitHub token: ${credentials[3]}`,
    ].join("\n");

    const output = redactModelVisibleToolPayloadText(input);

    expect(output).toContain("token = timeObserverToken");
    expect(output).toContain('"api_key": "computeToken()"');
    for (const credential of credentials) {
      expect(output).not.toContain(credential);
    }
  });
});

describe("redactSensitiveText", () => {
  it("preserves long blank runs without stalling the default redaction scan", () => {
    const input = `<details>a${"\n".repeat(60_000)}X</details>`;
    const started = performance.now();
    expect(redactSensitiveText(input, { mode: "tools" })).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("preserves shell env references in assignments", () => {
    const input = [
      'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"',
      "OPENAI_API_KEY=$OPENAI_API_KEY",
      "API_KEY=$API_KEY",
      "TOKEN=${TOKEN}",
      "PASSWORD=${PASSWORD:-}",
      "GITHUB_TOKEN=${GITHUB_TOKEN}",
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks literal shell env expansion defaults in assignments", () => {
    const fallback = "discordliteral1234567890";
    const input = `DISCORD_BOT_TOKEN="\${DISCORD_BOT_TOKEN:-${fallback}}"`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).not.toContain(fallback);
    expect(output).toBe('DISCORD_BOT_TOKEN="${DISC…890}"');
  });

  it("masks JSON-escaped quoted env assignments while keeping the key", () => {
    const xai = "issue85049-xai-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const brave = "issue85049-brave-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const input = String.raw`raw_params={"command":"export XAI_API_KEY=\"${xai}\" && export BRAVE_API_KEY=\\\"${brave}\\\" && echo blocked"}`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain("XAI_API_KEY=");
    expect(output).toContain("BRAVE_API_KEY=");
    expect(output).not.toContain(xai);
    expect(output).not.toContain(brave);
    expect(output).toContain("issue8…7890");
  });

  it("masks AWS secret access keys in labeled and bare credential text", () => {
    const secret = Array.from(
      { length: 40 },
      (_entry, index) => (["W", "j", "7", "/"] as const)[index % 4] ?? "W",
    ).join("");
    const input = [
      `aws_secret_access_key = ${secret}`,
      JSON.stringify({ SecretAccessKey: secret }),
      `bare ${secret}`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    const masked = `${secret.slice(0, 6)}…${secret.slice(-4)}`;

    expect(output).toContain(`aws_secret_access_key = ${masked}`);
    expect(output).toContain(`"SecretAccessKey":"${masked}"`);
    expect(output).toContain(`bare ${masked}`);
    expect(output).not.toContain(secret);
  });

  it("masks AWS secret access key CLI flags by key", () => {
    const secretWithoutBareHeuristic = Array.from(
      { length: 40 },
      (_entry, index) => (["A", "b", "C", "d"] as const)[index % 4] ?? "A",
    ).join("");
    const input = [
      `cmd --aws-secret-access-key=${secretWithoutBareHeuristic}`,
      `cmd --awsSecretAccessKey ${secretWithoutBareHeuristic}`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).not.toContain(secretWithoutBareHeuristic);
    expect(output).toContain("--aws-secret-access-key=AbCdAb…AbCd");
    expect(output).toContain("--awsSecretAccessKey AbCdAb…AbCd");
  });

  it("does not treat option-alternative prose as a CLI flag secret", () => {
    const input = "Use either --password or --password-file.";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks resource-scoped hosted-media bearer query tokens", () => {
    const id = "a".repeat(24);
    const token = "b".repeat(48);
    const input = `GET https://gateway.example.com/webhooks/sms?safe=value&__openclaw_mms_token_${id}=${token}`;
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toContain(`safe=value&__openclaw_mms_token_${id}=`);
    expect(output).not.toContain(token);
  });

  it.each([
    ["matrix access_token=abcdef1234567890ghij next", "matrix access_token=abcdef…ghij next"],
    ["failed [token=fixture-secret]; retry", "failed [token=*** retry"],
    ["failed [token='has\"quotes']; retry", "failed [token='***']; retry"],
    ["failed {secret=`has'quotes`}; retry", "failed {secret=`***`}; retry"],
    ['failed (token="unterminated retry', "failed (token=*** retry"],
  ])("masks standalone diagnostic assignments: %s", (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it("masks payment credential JSON fields without redacting unrelated amounts", () => {
    const input =
      '{"card_number":"4242424242424242","cvc":"123","sharedPaymentToken":"spt_abcdefghijklmnopqrstuvwxyz","payment_credential":"paycred_abcdefghijklmnopqrstuvwxyz","amount":"4200"}';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      '{"card_number":"***","cvc":"***","sharedPaymentToken":"spt_ab…wxyz","payment_credential":"paycre…wxyz","amount":"4200"}',
    );
  });

  it("masks HTTP client config secrets in JSON and object-inspection fields", () => {
    const appSecret = "feishu_app_secret_1234567890";
    const clientSecret = "oauth_client_secret_1234567890";
    const credential = "opaque_credential_1234567890";
    const input = [
      `body: {"app_secret":"${appSecret}"}`,
      `config: { appSecret: '${appSecret}', client_secret: '${clientSecret}' }`,
      `payload: {"credential":"${credential}"}`,
      `details: { credential: '${credential}' }`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain('"app_secret":"feishu…7890"');
    expect(output).toContain("appSecret: 'feishu…7890'");
    expect(output).toContain("client_secret: 'oauth_…7890'");
    expect(output).toContain('"credential":"***"');
    expect(output).toContain("credential: 'opaque…7890'");
    expect(output).not.toContain(appSecret);
    expect(output).not.toContain(clientSecret);
    expect(output).not.toContain(credential);
  });

  it("masks quoted HTTP auth headers in object-inspection fields", () => {
    const bearer = "feishu_tenant_access_abcdef123456";
    const cookie = "session_cookie_value_abcdef123456";
    const input = `headers: { authorization: 'Bearer ${bearer}', cookie: '${cookie}' }`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain("authorization: '***'");
    expect(output).toContain("cookie: 'sessio…3456'");
    expect(output).not.toContain(bearer);
    expect(output).not.toContain(cookie);
  });

  it("masks structured uppercase env-style field values by key", () => {
    expect(redactSensitiveFieldValue("GITHUB_TOKEN", "abcdefghijklmnopqrstuvwx1234567890")).toBe(
      "abcdef…7890",
    );
    expect(redactSensitiveFieldValue("DISCORD_BOT_TOKEN", "${DISCORD_BOT_TOKEN:-}")).toBe(
      "${DISCORD_BOT_TOKEN:-}",
    );
    expect(redactSensitiveFieldValue("apiKey", "${OPENAI_API_KEY:-}")).toBe("${OPEN…Y:-}");
    expect(redactSensitiveFieldValue("password", "$SUPERSECRET123")).toBe("***");
    expect(
      redactSensitiveFieldValue(
        "DISCORD_BOT_TOKEN",
        "${DISCORD_BOT_TOKEN:-discordliteral1234567890}",
      ),
    ).toBe("${DISCORD_BOT_TOKEN:-disco…890}");
    expect(redactSensitiveFieldValue("MONKEY", "banana")).toBe("banana");
  });

  it("keeps Unicode token hints on valid UTF-16 boundaries", () => {
    const cases: [string, string][] = [
      [`abcde😀${"x".repeat(9)}wxyz`, "abcde…wxyz"],
      [`abcdef${"x".repeat(9)}😀abc`, "abcdef…abc"],
      [`abcd😀${"x".repeat(9)}😀ab`, "abcd😀…😀ab"],
    ];
    for (const [secret, expected] of cases) {
      const redacted = redactSensitiveFieldValue("token", secret);
      expect(redacted).toBe(expected);
      expect(redacted).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });

  it("masks structured authorization parameters without consuming diagnostics", () => {
    const input = [
      'Authorization: Digest username="digest-user-example", 2fa="digest-extension-1234567890abcdef", response="digest-response-1234567890abcdef", extension="digest-tail-1234567890abcdef", cnonce="tail-nonce"; request_id=digest-example',
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1234567890/20260717/eu-west-1/s3/aws4_request, SignedHeaders=:authority;x_custom;x.custom, Signature=aws-signature-1234567890abcdef; status=403",
      'Proxy-Authorization: Digest username="digest-user-example", response="digest-response-1234567890abcdef"; request_id=proxy-example',
    ].join("\n");
    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Digest ***; request_id=digest-example",
        "Authorization: AWS4-HMAC-SHA256 ***; status=403",
        "Proxy-Authorization: Digest ***; request_id=proxy-example",
      ].join("\n"),
    );
  });

  it("masks consecutive, prefixed, and serialized auth headers", () => {
    const proxyValue = ["cHJveH", "k6cGFz", "cw=="].join("");
    const customValue = ["Y3VzdG", "9tOnBh", "c3M="].join("");
    const accessValue = ["sample", "access", "value", "1234567890"].join("-");
    const googleValue = ["sample", "google", "value", "1234567890"].join("-");
    const input = [
      "Proxy-Authorization: Foo",
      `Proxy-Authorization: Basic ${proxyValue}`,
      `X-Authorization: Basic ${customValue}`,
      JSON.stringify({
        "x-access-token": accessValue,
        "x-goog-api-key": googleValue,
      }),
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toContain("Proxy-Authorization: Basic ***");
    expect(output).toContain("X-Authorization: Basic ***");
    for (const credential of [proxyValue, customValue, accessValue, googleValue]) {
      expect(output).not.toContain(credential);
    }
  });

  it("masks malformed and folded auth parameters", () => {
    const input = [
      'Authorization: Digest username="sample",,response="later-response-value-1234567890"; status=401',
      'Authorization: Digest damaged,,response="later-response-value-1234567890"; status=403',
      'Authorization: Digest username="sample",\r\n response="later-response-value-1234567890"; status=408',
      "Authorization:\\nBasic Zm9sZGVkOnNlY3JldA==",
    ].join("\n");
    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Digest ***; status=401",
        "Authorization: Digest ***; status=403",
        "Authorization: Digest ***; status=408",
        "Authorization:\\nBasic Zm9sZG…dA==",
      ].join("\n"),
    );
  });
  it("masks nested serialized auth objects", () => {
    const response = ["nested", "digest", "response", "1234567890abcdef"].join("-");
    const header = { Authorization: `Digest response="${response}\\\\"` };
    const input = JSON.stringify(JSON.stringify(header));

    expect(redactSensitiveText(input, { mode: "tools" })).toBe(
      JSON.stringify(JSON.stringify({ Authorization: "Digest ***" })),
    );
    expect(redactSensitiveText(JSON.stringify(header), { mode: "tools" })).toBe(
      JSON.stringify({ Authorization: "***" }),
    );
  });

  it("masks punctuated auth schemes and nested token credentials", () => {
    const token = "extension-token-1234567890abcdef";
    const nested = (Authorization: string) => JSON.stringify(JSON.stringify({ Authorization }));
    expect(redactSensitiveText(`Authorization: Foo+Bar ${token}; status=401`)).toBe(
      "Authorization: Foo+Bar extens…cdef; status=401",
    );
    expect(redactSensitiveText(nested("Basic dXNlcjpwYXNz"))).toBe(nested("Basic ***"));
    expect(redactSensitiveText(nested("Bearer /opaque-~bearer-1234567890abcdef"))).toBe(
      nested("Bearer /opaqu…cdef"),
    );
    const opaque = JSON.stringify(
      JSON.stringify({
        Authorization: "opaque-credential-1234567890abcdef",
        "Proxy-Authorization": "opaque-credential-1234567890abcdef",
      }),
    );
    expect(redactSensitiveText(opaque)).toBe(
      JSON.stringify(
        JSON.stringify({
          Authorization: "opaque…cdef",
          "Proxy-Authorization": "opaque…cdef",
        }),
      ),
    );
  });

  it("keeps token68 padding out of structured auth parsing", () => {
    expect(
      redactSensitiveText("Authorization: Basic dXNlcg==, status=401", { mode: "tools" }),
    ).toBe("Authorization: Basic ***, status=401");
  });

  it("masks escaped auth fields containing encoded quoted-pairs", () => {
    const response = ["escaped", "quoted", "response", "1234567890abcdef"].join("-");
    const input = `Authorization: Digest realm=\\"Example \\\\\\"Realm\\\\\\"\\", response=\\"${response}\\"; status=401`;
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toBe("Authorization: Digest ***; status=401");
    expect(output).not.toContain(response);
  });

  it("masks opaque authorization across bounded-replacement chunks", () => {
    const headerValue = `${"A".repeat(96)}==`;
    const standaloneValue = `${"B".repeat(96)}==`;
    const input = `${"x".repeat(32_760)} Authorization: Bearer ${headerValue}\nrequest failed: Bearer ${standaloneValue}`;
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).not.toContain(headerValue);
    expect(output).not.toContain(standaloneValue);
    expect(output).toContain("Authorization: Bearer AAAAAA…AA==");
    expect(output).toContain("request failed: Bearer BBBBBB…BB==");
  });

  it("preserves diagnostics following unquoted credential-style headers", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const value = ["sample", "key", "value", "1234567890"].join("");
    const output = redactSensitiveText(`${keyHeader}: ${value}, request_id=example, status=500`, {
      mode: "tools",
    });

    expect(output).not.toContain(value);
    expect(output).toContain(", request_id=example, status=500");
  });

  it("masks named Gateway security headers", () => {
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";
    const apiKey = "shortsecret";
    const input = [
      `X-OpenClaw-Token: ${openClawToken}`,
      `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
      `X-Api-Key=${apiKey}`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toContain("X-OpenClaw-Token: supers…7890");
    expect(output).toContain("x-pomerium-jwt-assertion: eyJhea…3456");
    expect(output).toContain("X-Api-Key=***");
    expect(output).not.toContain(openClawToken);
    expect(output).not.toContain(pomeriumJwt);
    expect(output).not.toContain(apiKey);
  });

  it("masks URL punctuation inside named Gateway header values", () => {
    expect(redactSensitiveText("X-Api-Key: prefix&secret#suffix", { mode: "tools" })).toBe(
      "X-Api-Key: prefix…ffix",
    );
    expect(
      redactSensitiveText("X-OpenClaw-Token=prefix&actual-secret#tail", { mode: "tools" }),
    ).toBe("X-OpenClaw-Token=prefix…tail");
    expect(redactSensitiveText("x-access-token=prefix&actual-secret#tail", { mode: "tools" })).toBe(
      "x-access-token=prefix…tail",
    );
  });

  it("keeps equals-assignment bitmap masking aligned with form parsing", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    const form = "x-access-token=short-at-123&safe=value";
    const formBitmap = computeSensitiveRedactionBitmap(form, resolved);
    const safePairStart = form.indexOf("&safe=");
    expect(formBitmap.slice(form.indexOf("=") + 1, safePairStart).every(Boolean)).toBe(true);
    expect(formBitmap.slice(safePairStart).some(Boolean)).toBe(false);

    const header = "X-OpenClaw-Token=prefix&actual-secret#tail";
    const headerBitmap = computeSensitiveRedactionBitmap(header, resolved);
    expect(headerBitmap.slice(header.indexOf("=") + 1).every(Boolean)).toBe(true);
  });

  it("keeps original bitmap offsets after empty values and Unicode line prefixes", () => {
    const input = '😀safe\r\nbody: code=&safe=1\rclient%5Fsecret="abc";&safe=2';
    const resolved = resolveRedactOptions({ mode: "tools" });
    const bitmap = computeSensitiveRedactionBitmap(input, resolved);
    const secretStart = input.indexOf('"abc"');

    expect(redactSensitiveText(input)).toBe(
      "😀safe\r\nbody: code=***&safe=1\rclient%5Fsecret=***;&safe=2",
    );
    expect(bitmap).toHaveLength(input.length);
    expect(bitmap.slice(0, secretStart).some(Boolean)).toBe(false);
    expect(bitmap.slice(secretStart, secretStart + 5).every(Boolean)).toBe(true);
    expect(bitmap.slice(secretStart + 5).some(Boolean)).toBe(false);
  });

  it("masks token prefixes embedded after adjacent text", () => {
    const token = `ghp_${"a".repeat(5_000)}`;
    const output = redactSensitiveText(`prefix-${token} suffix`, { mode: "tools" });
    expect(output).toBe("prefix-ghp_aa…aaaa suffix");
    expect(output).not.toContain(token);
    expect(output).not.toContain("a".repeat(100));
  });

  it("masks config assignments while preserving safe options", () => {
    const input = [
      "password = db-password-fixture-1234567890",
      'password= "db-password-fixture-1234567890"',
      "database_password: database-password-fixture-1234567890",
      "api_secret='api-secret-fixture-1234567890'",
      "jdbc.password=db-password-fixture-1234567890",
      'jdbc.password="db-password-fixture-1234567890"',
      "secret_key=django-secret-key-1234567890",
      "service_tls_passphrase: 'tls-passphrase-fixture-1234567890'",
      "safe_option = visible",
    ];
    expect(redactSensitiveText(input.join("\n"))).toBe(
      [
        "password = db-pas…7890",
        'password= "db-pas…7890"',
        "database_password: databa…7890",
        "api_secret='api-se…7890'",
        "jdbc.password=db-pas…7890",
        'jdbc.password="db-pas…7890"',
        "secret_key=django…7890",
        "service_tls_passphrase: 'tls-pa…7890'",
        "safe_option = visible",
      ].join("\n"),
    );
  });

  it("masks complete unquoted assignment values that contain delimiter-like punctuation", () => {
    const input = "password=abc,def token=abc;def client_secret=abc]def pass=abc)def";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("password=*** token=*** client_secret=*** pass=***");
    expect(output).not.toContain("abc,def");
    expect(output).not.toContain("abc;def");
    expect(output).not.toContain("abc]def");
    expect(output).not.toContain("abc)def");
  });

  it("masks opaque sensitive URL query params without known token prefixes", () => {
    const input =
      "callback https://example.test/oauth?code=oauth-code-abc123&state=visible&x-amz-signature=abc123xyz&x-amz-security-token=aws-session-token-123&authorization=authz-secret-123&private_key=pk-secret-123&app_secret=app-secret-123&credential=credential-secret-123";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "callback https://example.test/oauth?code=***&state=visible&x-amz-signature=***&x-amz-security-token=aws-se…-123&authorization=***&private_key=***&app_secret=***&credential=creden…-123",
    );
  });

  it("masks canonical URL auth aliases in form bodies without consuming safe fields", () => {
    const input =
      "sig=short-sig-123&x-api-key=short-key-123&x-access-token=short-at-123&x-auth-token=short-authtok&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("sig=***&x-api-key=***&x-access-token=***&x-auth-token=***&safe=value");
    expect(output).not.toContain("short-sig-123");
    expect(output).not.toContain("short-key-123");
  });

  it("reaches sig-only URLs and form bodies through the default prefilter", () => {
    expect(redactSensitiveText("https://example.test/cb?sig=opaque-signed-value")).toBe(
      "https://example.test/cb?sig=opaque…alue",
    );
    expect(redactSensitiveText("sig=opaque-signed-value&safe=visible")).toBe(
      "sig=***&safe=visible",
    );
  });

  it("masks URL userinfo and connection-string passwords", () => {
    const input = [
      "https://browser-user:browser-password-1234567890@api.example.test/v1",
      "https://:empty-username-password-1234567890@api.example.test/v1",
      "postgres://secret:secret@db.example.test/openclaw",
      "mongodb+srv://mongo:mongodb-password-1234567890@cluster.example.test/app",
    ].join(" ");
    expect(redactSensitiveText(input)).toBe(
      [
        "https://browser-user:browse…7890@api.example.test/v1",
        "https://:empty-…7890@api.example.test/v1",
        "postgres://secret:***@db.example.test/openclaw",
        "mongodb+srv://mongo:mongod…7890@cluster.example.test/app",
      ].join(" "),
    );
  });

  it("masks sensitive form-urlencoded body fields by exact key", () => {
    const input =
      "code=oauth-code-123&hook_token=hook-token-123&jwt=jwt-secret-123&pass=form-pass-123&client_secret=oauth-client-secret-1234567890&refresh_token=refresh-token-1234567890&token_count=42&session_id=session-visible";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "code=***&hook_token=***&jwt=***&pass=***&client_secret=***&refresh_token=***&token_count=42&session_id=session-visible",
    );
    expect(output).not.toContain("oauth-code-123");
    expect(output).not.toContain("hook-token-123");
    expect(output).not.toContain("jwt-secret-123");
    expect(output).not.toContain("form-pass-123");
    expect(output).not.toContain("oauth-client-secret-1234567890");
    expect(output).not.toContain("refresh-token-1234567890");
  });

  it("masks quoted form body values after equals", () => {
    const input =
      'body: password="opaque-password-secret" client_id=visible&app_secret="opaque-app-secret"&safe=1';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: password=*** client_id=visible&app_secret=***&safe=1");
    expect(output).not.toContain("opaque-password-secret");
    expect(output).not.toContain("opaque-app-secret");
  });

  it("masks complete URL query values that contain delimiter-like punctuation", () => {
    const input =
      "GET /cb?token=abc)def&safe=1 /cb?client%5Fsecret=abc]def&safe=1 /cb?code=short#frag";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "GET /cb?token=***&safe=1 /cb?client%5Fsecret=***&safe=1 /cb?code=***#frag",
    );
    expect(output).not.toContain("abc)def");
    expect(output).not.toContain("abc]def");
    expect(output).toContain("#frag");
  });

  it("masks quoted URL query values after equals", () => {
    const input = 'GET /cb?token="opaque-token-secret"&safe=1 /cb?client%5Fsecret="oauth-secret"';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET /cb?token=opaque…cret&safe=1 /cb?client%5Fsecret=***");
    expect(output).not.toContain("opaque-token-secret");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks encoded sensitive form keys in single-pair and multiline diagnostics", () => {
    const input = [
      "client%5Fsecret=single-secret",
      "trace body: client%5Fsecret=multiline-secret&safe=1",
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("client%5Fsecret=***\ntrace body: client%5Fsecret=***&safe=1");
    expect(output).not.toContain("single-secret");
    expect(output).not.toContain("multiline-secret");
  });

  it("masks single-pair form fields in explicit body contexts", () => {
    const input = "body: code=oauth-code-123 form_body=signature=aws-signature-123 Oops code=E1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: code=*** form_body=signature=*** Oops code=E1");
    expect(output).not.toContain("oauth-code-123");
    expect(output).not.toContain("aws-signature-123");
  });

  it("redactSensitiveText keeps form-body protection when custom patterns replace the string list", () => {
    const input = "password=value&safe=1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [String.raw`custom-secret-([A-Za-z0-9]+)`],
    });
    expect(output).toBe("password=***&safe=1");
  });

  it.each([
    ["an unmatched group", String.raw`(unused)?project_value=([^&]+)&confirm=\2`],
    ["an empty last group", String.raw`project_value=([^&]+)()&confirm=\1`],
    ["a named backreference", String.raw`project_value=(?<secret>[^&]+)&confirm=\k<secret>`],
  ])("redactSensitiveText locates the custom capture with %s", (_name, pattern) => {
    const input = "project_value=abc123456789012345&confirm=abc123456789012345";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [pattern],
    });
    expect(output).toBe("project_value=abc123…2345&confirm=abc123456789012345");
  });

  it("masks representative vendor token grammars through the default fast path", () => {
    const tokens = [
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "gho_abcdefghijklmnopqrstuvwxyz",
      "glpat-abcdefghijklmnopqrstuvwxyz12.ab.abcdefghi",
      ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwxyz"].join("-"),
      "https://hooks.slack.com/services/T1234567890/B1234567890/abcdefghijklmnopqrstuvwxy",
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef",
      `discord bot token ${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(27)}`,
      "AIzaabcdefghijklmnopqrstuvwxyzABCDE",
      "fc-abcdefghijklmnopqrstuvwxyz",
      "gAAAAabcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      "SG.abcdefghijklmnopqrstuvwxyz.0123456789abcdefghijklmnopqrstuvwxyz",
      `glc_eyJ${"A".repeat(80)}`,
      `ATATT${"A".repeat(48)}=ABCDEF12`,
      `FlyV1 fm123_${"A".repeat(120)}`,
      "am_abcdefghijklmnopqrstuvwxyz",
      "sk_abcdefghijklmnopqrstuvwxyz",
      `fw-${"C".repeat(40)}`,
      `fw_${"A".repeat(40)}`,
      `fpk_${"B".repeat(40)}`,
    ];
    // Isolated inputs require each grammar to reach the default prefilter itself.
    for (const token of tokens) {
      expect(redactSensitiveText(token), token).not.toContain(token);
    }
  });
  it("masks additional GitLab token prefixes through the default fast path", () => {
    const dashToken = (prefix: string, suffix: string): string => [prefix, suffix].join("-");
    const repeatedDashToken = (prefix: string, length: number): string =>
      dashToken(prefix, "A".repeat(length));
    const legacyOauthToken = dashToken("gloas", "a".repeat(32));
    const longHexOauthToken = dashToken("gloas", "a".repeat(80));
    const mixedOauthToken = dashToken("gloas", `${"a".repeat(32)}Z${"b".repeat(31)}`);
    const tokens = [
      legacyOauthToken,
      longHexOauthToken,
      mixedOauthToken,
      repeatedDashToken("gldt", 20),
      repeatedDashToken("glft", 20),
      dashToken("glft", "a0b1-123_"),
      dashToken("glrt", `${"A".repeat(27)}.01.${"a".repeat(9)}`),
      dashToken("glrtr", `${"A".repeat(27)}.01.${"a".repeat(9)}`),
    ];

    for (const token of tokens) {
      expect(redactSensitiveText(token, { mode: "tools" }), token).not.toContain(token);
    }
    expect(redactSensitiveText(mixedOauthToken, { mode: "tools" })).not.toContain(
      mixedOauthToken.slice("gloas-".length + 32),
    );
    expect(redactSensitiveText(longHexOauthToken, { mode: "tools" })).not.toContain(
      longHexOauthToken.slice("gloas-".length + 64),
    );
    expect(redactSensitiveText(`${legacyOauthToken}_suffix`, { mode: "tools" })).not.toContain(
      legacyOauthToken,
    );
    expect(redactSensitiveText(`${longHexOauthToken}_suffix`, { mode: "tools" })).not.toContain(
      `${longHexOauthToken.slice("gloas-".length + 64)}_suffix`,
    );
  });

  it("does not redact ordinary identifiers containing short token-prefix substrings", () => {
    const input = [
      "npm_telegram_package_spec ask_openclaw_query_patterns team_management risk_assessment glpat-docs gloas-docs gldt-docs glcbt-docs glptt-docs glft-docs glimt-docs glagent-docs glwt-docs glsoat-docs glffct-docs glrt-docs glrtr-docs GR1348941-docs _gitlab_session=short dapi-example sbp_short nfp_site CCIPAT_docs ATATT-example fw-tooshort fw_tooshort fpk_tooshort",
      `fixturefw-${"C".repeat(40)}`,
      `fixture_fw_${"A".repeat(40)}`,
      `fixture_fpk_${"B".repeat(40)}`,
    ].join(" ");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks Telegram bot tokens that cross bounded-replacement chunk boundaries", () => {
    const chunkSize = 16_384;
    const credential = `123456:${"A".repeat(28)}WXYZ`;
    const cases = [
      { token: `bot${credential}`, redacted: "bot123456…WXYZ" },
      { token: credential, redacted: "123456…WXYZ" },
    ];

    for (const { token, redacted } of cases) {
      const tokenStart = chunkSize - 12;
      const prefix = `${"x".repeat(tokenStart - 1)} `;
      const suffix = ` ${"y".repeat(chunkSize * 2)}`;
      expect(redactSensitiveText(`${prefix}${token}${suffix}`, { mode: "tools" })).toBe(
        `${prefix}${redacted}${suffix}`,
      );
    }
  });

  it("does not corrupt large data URLs across chunked replacement boundaries", () => {
    // replacePatternBounded slices 32 KiB+ inputs into 16 KiB chunks; a chunk start must not
    // satisfy the pure-base64 prefix boundary (`^`) or hide the `;base64,` container from its
    // lookbehind, so the boundary patterns run unchunked.
    const prefix = "data:application/octet-stream;base64,";
    const chunkSize = 16_384;
    const pad = "A".repeat(chunkSize * 2 - prefix.length);
    const dataUrl = `${prefix}${pad}gAAAA${"B".repeat(24)}${"C".repeat(chunkSize)}`;
    expect(redactSensitiveText(dataUrl, { mode: "tools" })).toBe(dataUrl);
  });

  it("masks obfuscated form keys with opaque values through the default options path", () => {
    // Values intentionally avoid literal prefilter trigger words so the obfuscated key alone
    // must make the default fast path run.
    expect(
      redactSensitiveText("body: client%5Fse\u200Bcret=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("body: client%5Fse\u200Bcret=***&safe=1");
    expect(
      redactSensitiveText("GET https://example.test/cb?client_se+cret=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("GET https://example.test/cb?client_se+cret=***&safe=1");
    expect(
      redactSensitiveText("body: client_secre%74=opaque-value-123&safe=1", { mode: "tools" }),
    ).toBe("body: client_secre%74=***&safe=1");
    expect(
      redactSensitiveText("body: client_se\u3164cret\u3164=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("body: client_se\u3164cret\u3164=***&safe=1");
  });

  it("redacts raw secret values that contain an ellipsis", () => {
    const input = "password=abcdef…1234567890";
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toBe("password=***");
    expect(redactSensitiveFieldValue("password", "abcdef…1234567890")).toBe("***");
  });

  it("resolveRedactOptions does not resolve patterns when mode is off", () => {
    const options = {
      mode: "off" as const,
      get patterns(): never {
        throw new Error("patterns should not be read when redaction is off");
      },
    };

    expect(resolveRedactOptions(options)).toEqual({
      mode: "off",
      patterns: [],
    });
    expect(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdef", options)).toBe(
      "OPENAI_API_KEY=sk-1234567890abcdef",
    );
  });

  it("keeps custom redaction patterns active for structured sensitive fields", () => {
    expect(
      redactSensitiveFieldValue("TOKEN", "${TOKEN}", {
        mode: "tools",
        patterns: [/TOKEN/g],
      }),
    ).toBe("${***}");
  });

  it("keeps configured redaction patterns active for text outside default markers", () => {
    const configPath = writeConfig(`{
      logging: {
        redactPatterns: ["/internal-\\\\d+/g"],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      expect(redactSensitiveText("ticket internal-12345 should hide")).toBe(
        "ticket *** should hide",
      );
      expect(redactSecrets({ detail: "ticket internal-12345 should hide" })).toEqual({
        detail: "ticket *** should hide",
      });
    });
  });
});

describe("redactSecrets", () => {
  it("redacts nested structured payloads before JSON persistence", () => {
    const input = {
      permissions: { access: "read", refresh: "monthly" },
      plugin: {
        config: {
          apiKey: "AIzaSyD-very-real-looking-google-api-key-123",
          access: "ya29.fake-access-token-with-enough-length",
          refresh: "1//0fake-refresh-token-with-enough-length",
          password: "abcd-efgh-ijkl-mnop",
        },
      },
      transcript: [
        {
          text: "jwt eyJheaderabcd.eyJpayloadabcd.signatureabcd123456 and main-test-case-name",
        },
        {
          text: "standalone app password abcd-efgh-ijkl-mnop",
          errorMessage: "failed with app password qrst-uvwx-yzab-cdef",
        },
      ],
    };

    const output = redactSecrets(input);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("AIzaSyD-very-real-looking");
    expect(serialized).not.toContain("ya29.fake-access-token");
    expect(serialized).not.toContain("1//0fake-refresh-token");
    expect(serialized).not.toContain("eyJheaderabcd.eyJpayloadabcd.signatureabcd123456");
    expect(serialized).not.toContain("abcd-efgh-ijkl-mnop");
    expect(serialized).not.toContain("qrst-uvwx-yzab-cdef");
    expect(serialized).toContain("main-test-case-name");
    expect(output.permissions).toEqual(input.permissions);
  });

  it.each(["EAI_AGAIN"])(
    "preserves the known transport code %s only in object cause chains",
    (code) => {
      expect(redactSecrets({ cause: { code, cause: { code } } })).toEqual({
        cause: { code, cause: { code } },
      });
      expect(redactSecrets({ Cause: { CODE: code } })).toEqual({ Cause: { CODE: code } });
    },
  );

  it.each([
    { input: { cause: { code: "p4Q6x7J9" } }, expected: { cause: { code: "***" } } },
    { input: { cause: { code: 123456 } }, expected: { cause: { code: "***" } } },
    { input: { cause: { code: true } }, expected: { cause: { code: "***" } } },
    { input: { cause: { code: 123456n } }, expected: { cause: { code: "***" } } },
    {
      input: { oauth: { cause: { code: "EAI_AGAIN" } } },
      expected: { oauth: { cause: { code: "***" } } },
    },
    { input: { cause: [{ code: "EAI_AGAIN" }] }, expected: { cause: [{ code: "***" }] } },
    { input: { cause: { code: ["EAI_AGAIN"] } }, expected: { cause: { code: ["***"] } } },
    { input: [{ cause: { code: "EAI_AGAIN" } }], expected: [{ cause: { code: "***" } }] },
  ])(
    "masks authorization codes outside the exact transport boundary: $input",
    ({ input, expected }) => {
      expect(redactSecrets(input)).toEqual(expected);
    },
  );

  it("keeps secret masking ahead of known transport code preservation", () => {
    registerSecretValueForRedaction("EAI_AGAIN");
    const output = redactSecrets({ cause: { code: "EAI_AGAIN", token: "opaque-neighbor-secret" } });
    expect(output.cause.code).not.toBe("EAI_AGAIN");
    expect(output.cause.token).not.toBe("opaque-neighbor-secret");
  });

  it("preserves diagnostic codes and source paths while masking authorization fields", () => {
    const output = redactSecrets({
      manifest: {
        sourceFiles: { session: "$WORKSPACE_DIR/session.jsonl" },
        warnings: [{ code: "invalid-runtime-event" }],
      },
      status: { code: "SYSTEM_RUN_DENIED" },
      nodeError: { code: "NOT_PAIRED" },
      error: { code: "ERR_ROOTOPAQUECODE1234567890" },
      provider: { code: "provider-code-value-1234567890" },
      providerNestedError: { error: { code: "ERR_PROVIDEROPAQUECODE1234567890" } },
      bearerToken: "bearer-token-value-1234567890",
      numericSecrets: { cardNumber: 4111111111111111, cvc: 123, token: 1234567890, amount: 4200 },
    });
    expect(output).toEqual({
      manifest: {
        sourceFiles: { session: "$WORKSPACE_DIR/session.jsonl" },
        warnings: [{ code: "invalid-runtime-event" }],
      },
      status: { code: "SYSTEM_RUN_DENIED" },
      nodeError: { code: "NOT_PAIRED" },
      error: { code: "ERR_ROOTOPAQUECODE1234567890" },
      provider: { code: "provid…7890" },
      providerNestedError: { error: { code: "ERR_PROVIDEROPAQUECODE1234567890" } },
      bearerToken: "bearer…7890",
      numericSecrets: { cardNumber: "***", cvc: "***", token: "***", amount: 4200 },
    });
  });
});

describe("redactSensitiveLines", () => {
  it("returns lines unmodified when redaction is off", () => {
    const resolved = resolveRedactOptions({ mode: "off", patterns: defaults });
    const secret = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(secret);
    const lines = [`TOKEN=abcdef1234567890ghij ${secret}`];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("redactSensitiveLines keeps structured auth protection with custom-only patterns", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: ["project-private"] });
    const response = ["line", "digest", "response", "1234567890abcdef"].join("-");

    expect(
      redactSensitiveLines(
        [`Authorization: Digest username="example", response="${response}"; status=401`],
        resolved,
      ),
    ).toEqual(["Authorization: Digest ***; status=401"]);
  });

  it("redacts folded structured auth across line batches", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    const response = ["folded", "line", "response", "1234567890abcdef"].join("-");

    expect(
      redactSensitiveLines(
        ["Authorization: Digest", ` response="${response}"; status=401`],
        resolved,
      ),
    ).toEqual(["Authorization: Digest", " ***; status=401"]);
  });

  it("redactSensitiveLines keeps registered secrets when custom regexes are rejected", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: ["/(a+)+$/"] });
    const secret = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(secret);
    expect(redactSensitiveLines([`TOKEN=abcdef1234567890ghij ${secret}`], resolved)).toEqual([
      "TOKEN=abcdef1234567890ghij opaque…7890",
    ]);
  });

  it("returns empty array unchanged — does not produce a synthetic blank line", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    expect(redactSensitiveLines([], resolved)).toStrictEqual([]);
  });

  it("redacts a PEM block spanning multiple lines in the array", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    const lines = [
      "log: key follows",
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
      "log: key done",
    ];
    const result = redactSensitiveLines(lines, resolved);
    const joined = result.join("\n");
    expect(joined).toContain("-----BEGIN PRIVATE KEY-----");
    expect(joined).toContain("-----END PRIVATE KEY-----");
    expect(joined).toContain("…redacted…");
    expect(joined).not.toContain("ABCDEF1234567890");
  });

  it("applies form-body redaction per line before joining for multiline patterns", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    const lines = [
      "jwt=opaque-jwt-secret-123&safe=1",
      "key=opaque-key-secret-123&safe=1",
      "https://example.test/cb?client%5Fsecret=oauth-secret&safe=1",
      "normal log line",
    ];
    expect(redactSensitiveLines(lines, resolved)).toEqual([
      "jwt=***&safe=1",
      "key=***&safe=1",
      "https://example.test/cb?client%5Fsecret=***&safe=1",
      "normal log line",
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
