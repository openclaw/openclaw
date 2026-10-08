import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { replacePatternBounded } from "./redact-bounded.js";
import { TOOL_PAYLOAD_AMBIGUOUS_ASSIGNMENT_PATTERNS } from "./redact-patterns.js";
import * as prefilters from "./redact-prefilter.js";
import { redactSourceInputTextWithConfig } from "./redact-source.js";
import {
  captureSensitiveTextRedactionSnapshot,
  computeSensitiveRedactionBitmap,
  createSensitiveTextRedactor,
  getDefaultRedactPatterns,
  redactLogRecordForTransport,
  redactModelVisibleSecrets,
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

type TextRedactionCase = [
  input: string,
  expected: string | undefined,
  absent?: string[],
  contains?: string[],
];

function expectTextRedactions(cases: TextRedactionCase[]) {
  for (const [input, expected, absent = [], contains = []] of cases) {
    const output = redactSensitiveText(input, { mode: "tools" });
    if (expected !== undefined) {
      expect(output, input).toBe(expected);
    }
    for (const secret of absent) {
      expect(output, input).not.toContain(secret);
    }
    for (const safe of contains) {
      expect(output, input).toContain(safe);
    }
  }
}

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
  it("distinguishes source literals from computations without changing diagnostics", () => {
    const cases: [masked: boolean, sources: string[]][] = [
      [
        true,
        [
          'const API_TOKEN = "fixture-only-not-a-real-secret"; return API_TOKEN;',
          "const API_TOKEN = `fixture-only-not-a-real-secret`; return API_TOKEN;",
          "const API_TOKEN = 987654321; return API_TOKEN;",
          "// API_TOKEN=fixture-only-not-a-real-secret\nreturn 42;",
          'const API_TOKEN = "fixture-only-not-a-real-secret"; @',
          '(token="fixture-only-not-a-real-secret");',
        ],
      ],
      [
        false,
        [
          "const API_TOKEN = computeToken(); return API_TOKEN;",
          "const API_TOKEN = (40 + 2); return API_TOKEN;",
          "const API_TOKEN = await computeToken(); return API_TOKEN;",
          "const HAS_API_TOKEN = false; return HAS_API_TOKEN;",
          "let API_TOKEN = null; return API_TOKEN;",
        ],
      ],
    ];
    for (const [masked, sources] of cases) {
      for (const source of sources) {
        const redacted = redactSourceInputTextWithConfig(source);
        expect(redactToolPayloadTextWithConfig(source), source).not.toBe(source);
        if (masked) {
          expect(redacted, source).not.toMatch(/fixture-only-not-a-real-secret|987654321/);
          expect(redacted, source).toContain("***");
          expect(redacted, source).not.toBe(source);
          expect(redactSourceInputTextWithConfig(redacted), source).toBe(redacted);
        } else {
          expect(redacted, source).toBe(source);
        }
      }
    }
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

  it("preserves shell references, option prose, and ordinary token-like identifiers", () => {
    for (const input of [
      [
        'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"',
        "OPENAI_API_KEY=$OPENAI_API_KEY",
        "API_KEY=$API_KEY",
        "TOKEN=${TOKEN}",
        "PASSWORD=${PASSWORD:-}",
        "GITHUB_TOKEN=${GITHUB_TOKEN}",
      ].join("\n"),
      "Use either --password or --password-file.",
      [
        "npm_telegram_package_spec ask_openclaw_query_patterns team_management risk_assessment glpat-docs gloas-docs gldt-docs glcbt-docs glptt-docs glft-docs glimt-docs glagent-docs glwt-docs glsoat-docs glffct-docs glrt-docs glrtr-docs GR1348941-docs _gitlab_session=short dapi-example sbp_short nfp_site CCIPAT_docs ATATT-example fw-tooshort fw_tooshort fpk_tooshort",
        `fixturefw-${"C".repeat(40)}`,
        `fixture_fw_${"A".repeat(40)}`,
        `fixture_fpk_${"B".repeat(40)}`,
      ].join(" "),
    ]) {
      expect(redactSensitiveText(input, { mode: "tools" }), input).toBe(input);
    }
  });

  it("keeps large data URLs unredacted across former chunk boundaries", () => {
    // Whole-text matching keeps the data-URL exemption: a `;base64,` container immediately
    // before a base64-safe token start must still suppress the boundary rules.
    const prefix = "data:application/octet-stream;base64,";
    const chunkSize = 16_384;
    const pad = "A".repeat(chunkSize * 2 - prefix.length);
    const dataUrl = `${prefix}${pad}gAAAA${"B".repeat(24)}${"C".repeat(chunkSize)}`;
    expect(redactSensitiveText(dataUrl, { mode: "tools" })).toBe(dataUrl);
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

  it("masks AWS secret access keys in bare text and keyed fields", () => {
    const bare = "Wj7/".repeat(10);
    const keyed = "AbCd".repeat(10);
    const cases: [secret: string, input: string[], expected: string[]][] = [
      [
        bare,
        [
          `aws_secret_access_key = ${bare}`,
          JSON.stringify({ SecretAccessKey: bare }),
          `bare ${bare}`,
        ],
        [
          `aws_secret_access_key = Wj7/Wj…Wj7/`,
          '"SecretAccessKey":"Wj7/Wj…Wj7/"',
          "bare Wj7/Wj…Wj7/",
        ],
      ],
      [
        keyed,
        [`cmd --aws-secret-access-key=${keyed}`, `cmd --awsSecretAccessKey ${keyed}`],
        ["--aws-secret-access-key=AbCdAb…AbCd", "--awsSecretAccessKey AbCdAb…AbCd"],
      ],
    ];
    for (const [secret, input, expected] of cases) {
      const output = redactSensitiveText(input.join("\n"), { mode: "tools" });
      expect(output).not.toContain(secret);
      for (const field of expected) {
        expect(output).toContain(field);
      }
    }
  });

  it("masks credential headers across text and serialized forms", () => {
    const bearer = "feishu_tenant_access_abcdef123456";
    const cookie = "session_cookie_value_abcdef123456";
    const proxyValue = ["cHJveH", "k6cGFz", "cw=="].join("");
    const customValue = ["Y3VzdG", "9tOnBh", "c3M="].join("");
    const accessValue = ["sample", "access", "value", "1234567890"].join("-");
    const googleValue = ["sample", "google", "value", "1234567890"].join("-");
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";
    const apiKey = "shortsecret";
    const keyHeader = ["api", "-", "key"].join("");
    const value = ["sample", "key", "value", "1234567890"].join("");
    expectTextRedactions([
      [
        `headers: { authorization: 'Bearer ${bearer}', cookie: '${cookie}' }`,
        undefined,
        [bearer, cookie],
        ["authorization: '***'", "cookie: 'sessio…3456'"],
      ],
      [
        [
          "Proxy-Authorization: Foo",
          `Proxy-Authorization: Basic ${proxyValue}`,
          `X-Authorization: Basic ${customValue}`,
          JSON.stringify({
            "x-access-token": accessValue,
            "x-goog-api-key": googleValue,
          }),
        ].join("\n"),
        undefined,
        [proxyValue, customValue, accessValue, googleValue],
        ["Proxy-Authorization: Basic ***", "X-Authorization: Basic ***"],
      ],
      [
        [
          `X-OpenClaw-Token: ${openClawToken}`,
          `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
          `X-Api-Key=${apiKey}`,
        ].join("\n"),
        undefined,
        [openClawToken, pomeriumJwt, apiKey],
        ["X-OpenClaw-Token: supers…7890", "x-pomerium-jwt-assertion: eyJhea…3456", "X-Api-Key=***"],
      ],
      [
        `${keyHeader}: ${value}, request_id=example, status=500`,
        undefined,
        [value],
        [", request_id=example, status=500"],
      ],
      ["X-Api-Key: prefix&secret#suffix", "X-Api-Key: prefix…ffix"],
      ["X-OpenClaw-Token=prefix&actual-secret#tail", "X-OpenClaw-Token=prefix…tail"],
      ["x-access-token=prefix&actual-secret#tail", "x-access-token=prefix…tail"],
    ]);
  });
  it("masks form-body credentials while preserving surrounding fields", () => {
    expectTextRedactions([
      [
        "sig=short-sig-123&x-api-key=short-key-123&x-access-token=short-at-123&x-auth-token=short-authtok&safe=value",
        "sig=***&x-api-key=***&x-access-token=***&x-auth-token=***&safe=value",
        ["short-sig-123", "short-key-123"],
      ],
      [
        "code=oauth-code-123&hook_token=hook-token-123&jwt=jwt-secret-123&pass=form-pass-123&client_secret=oauth-client-secret-1234567890&refresh_token=refresh-token-1234567890&token_count=42&session_id=session-visible",
        "code=***&hook_token=***&jwt=***&pass=***&client_secret=***&refresh_token=***&token_count=42&session_id=session-visible",
        [
          "oauth-code-123",
          "hook-token-123",
          "jwt-secret-123",
          "form-pass-123",
          "oauth-client-secret-1234567890",
          "refresh-token-1234567890",
        ],
      ],
      [
        'body: password="opaque-password-secret" client_id=visible&app_secret="opaque-app-secret"&safe=1',
        "body: password=*** client_id=visible&app_secret=***&safe=1",
        ["opaque-password-secret", "opaque-app-secret"],
      ],
      [
        [
          "client%5Fsecret=single-secret",
          "trace body: client%5Fsecret=multiline-secret&safe=1",
        ].join("\n"),
        "client%5Fsecret=***\ntrace body: client%5Fsecret=***&safe=1",
        ["single-secret", "multiline-secret"],
      ],
      [
        "body: code=oauth-code-123 form_body=signature=aws-signature-123 Oops code=E1",
        "body: code=*** form_body=signature=*** Oops code=E1",
        ["oauth-code-123", "aws-signature-123"],
      ],
    ]);
  });
  it("masks complete URL query credentials while preserving safe fields", () => {
    expectTextRedactions([
      [
        "GET /cb?token=abc)def&safe=1 /cb?client%5Fsecret=abc]def&safe=1 /cb?code=short#frag",
        "GET /cb?token=***&safe=1 /cb?client%5Fsecret=***&safe=1 /cb?code=***#frag",
        ["abc)def", "abc]def"],
        ["#frag"],
      ],
      [
        'GET /cb?token="opaque-token-secret"&safe=1 /cb?client%5Fsecret="oauth-secret"',
        "GET /cb?token=opaque…cret&safe=1 /cb?client%5Fsecret=***",
        ["opaque-token-secret", "oauth-secret"],
      ],
      [
        "callback https://example.test/oauth?code=oauth-code-abc123&state=visible&x-amz-signature=abc123xyz&x-amz-security-token=aws-session-token-123&authorization=authz-secret-123&private_key=pk-secret-123&app_secret=app-secret-123&credential=credential-secret-123",
        "callback https://example.test/oauth?code=***&state=visible&x-amz-signature=***&x-amz-security-token=aws-se…-123&authorization=***&private_key=***&app_secret=***&credential=creden…-123",
      ],
    ]);
  });
  it("masks complete standalone diagnostic assignments", () => {
    expectTextRedactions([
      ["matrix access_token=abcdef1234567890ghij next", "matrix access_token=abcdef…ghij next"],
      ["failed [token=fixture-secret]; retry", "failed [token=*** retry"],
      ["failed [token='has\"quotes']; retry", "failed [token='***']; retry"],
      ["failed {secret=`has'quotes`}; retry", "failed {secret=`***`}; retry"],
      ['failed (token="unterminated retry', "failed (token=*** retry"],
      [
        "password=abc,def token=abc;def client_secret=abc]def pass=abc)def",
        "password=*** token=*** client_secret=*** pass=***",
        ["abc,def", "abc;def", "abc]def", "abc)def"],
      ],
    ]);
  });
  it("masks authorization parameters without consuming diagnostics", () => {
    expectTextRedactions([
      [
        [
          'Authorization: Digest username="digest-user-example", 2fa="digest-extension-1234567890abcdef", response="digest-response-1234567890abcdef", extension="digest-tail-1234567890abcdef", cnonce="tail-nonce"; request_id=digest-example',
          "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1234567890/20260717/eu-west-1/s3/aws4_request, SignedHeaders=:authority;x_custom;x.custom, Signature=aws-signature-1234567890abcdef; status=403",
          'Proxy-Authorization: Digest username="digest-user-example", response="digest-response-1234567890abcdef"; request_id=proxy-example',
        ].join("\n"),
        [
          "Authorization: Digest ***; request_id=digest-example",
          "Authorization: AWS4-HMAC-SHA256 ***; status=403",
          "Proxy-Authorization: Digest ***; request_id=proxy-example",
        ].join("\n"),
      ],
      [
        [
          'Authorization: Digest username="sample",,response="later-response-value-1234567890"; status=401',
          'Authorization: Digest damaged,,response="later-response-value-1234567890"; status=403',
          'Authorization: Digest username="sample",\r\n response="later-response-value-1234567890"; status=408',
          "Authorization:\\nBasic Zm9sZGVkOnNlY3JldA==",
        ].join("\n"),
        [
          "Authorization: Digest ***; status=401",
          "Authorization: Digest ***; status=403",
          "Authorization: Digest ***; status=408",
          "Authorization:\\nBasic Zm9sZG…dA==",
        ].join("\n"),
      ],
      [
        `Authorization: Digest realm=\\"Example \\\\\\"Realm\\\\\\"\\", response=\\"${["escaped", "quoted", "response", "1234567890abcdef"].join("-")}\\"; status=401`,
        "Authorization: Digest ***; status=401",
        [["escaped", "quoted", "response", "1234567890abcdef"].join("-")],
      ],
      ["Authorization: Basic dXNlcg==, status=401", "Authorization: Basic ***, status=401"],
    ]);
  });

  it("preserves long blank runs without stalling the default redaction scan", () => {
    const input = `<details>a${"\n".repeat(60_000)}X</details>`;
    const started = performance.now();
    expect(redactSensitiveText(input, { mode: "tools" })).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it("masks resource-scoped hosted-media bearer query tokens", () => {
    const id = "a".repeat(24);
    const token = "b".repeat(48);
    const input = `GET https://gateway.example.com/webhooks/sms?safe=value&__openclaw_mms_token_${id}=${token}`;
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toContain(`safe=value&__openclaw_mms_token_${id}=`);
    expect(output).not.toContain(token);
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

  it("keeps long URL credentials reachable through the default prefilter", () => {
    const longPassword = "a".repeat(600);
    const longUsername = "u".repeat(600);
    for (const input of [
      `https://u:${longPassword}@example.test`,
      `https://${longUsername}:opaque-password-value-123@example.test`,
      `postgres://u:${longPassword}@example.test/db`,
    ]) {
      const output = redactSensitiveText(input);
      expect(output).not.toBe(input);
      expect(output).not.toContain(longPassword);
      expect(output).not.toContain("opaque-password-value-123");
    }
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

  it("masks Telegram bot tokens placed across former chunk boundaries", () => {
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

  it("keeps arbitrarily padded sensitive keys reachable through the default prefilter", () => {
    for (const key of [
      `p\u200Bassword${"\u200B".repeat(600)}`,
      `p%61ssword${"\u200B".repeat(600)}`,
      `p+assword${"\u200B".repeat(600)}`,
    ]) {
      const input = `${key}=opaque-value-123`;
      const output = redactSensitiveText(input, { mode: "tools" });
      expect(output).not.toContain("opaque-value-123");
    }
  });

  it("redacts raw secret values that contain an ellipsis", () => {
    const input = "password=abcdef…1234567890";
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toBe("password=***");
    expect(redactSensitiveFieldValue("password", "abcdef…1234567890")).toBe("***");
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

  it("preserves known transport codes only in object cause chains", () => {
    const cases: { input: unknown; expected: unknown }[] = [
      {
        input: { cause: { code: "EAI_AGAIN", cause: { code: "EAI_AGAIN" } } },
        expected: { cause: { code: "EAI_AGAIN", cause: { code: "EAI_AGAIN" } } },
      },
      { input: { Cause: { CODE: "EAI_AGAIN" } }, expected: { Cause: { CODE: "EAI_AGAIN" } } },
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
    ];
    for (const { input, expected } of cases) {
      expect(redactSecrets(input)).toEqual(expected);
    }
  });

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
  it("redacts line batches without changing safe lines or inventing empty lines", () => {
    const cases: { lines: string[]; expected: string[]; patterns?: string[] }[] = [
      {
        lines: [
          'Authorization: Digest username="example", response="line-digest-response-1234567890abcdef"; status=401',
        ],
        expected: ["Authorization: Digest ***; status=401"],
        patterns: ["project-private"],
      },
      {
        lines: [
          "Authorization: Digest",
          ' response="folded-line-response-1234567890abcdef"; status=401',
        ],
        expected: ["Authorization: Digest", " ***; status=401"],
      },
      { lines: [], expected: [] },
      {
        lines: [
          "jwt=opaque-jwt-secret-123&safe=1",
          "key=opaque-key-secret-123&safe=1",
          "https://example.test/cb?client%5Fsecret=oauth-secret&safe=1",
          "normal log line",
        ],
        expected: [
          "jwt=***&safe=1",
          "key=***&safe=1",
          "https://example.test/cb?client%5Fsecret=***&safe=1",
          "normal log line",
        ],
      },
    ];
    for (const { lines, expected, patterns } of cases) {
      expect(
        redactSensitiveLines(lines, resolveRedactOptions({ mode: "tools", patterns })),
      ).toStrictEqual(expected);
    }
  });
  it("returns lines unmodified when redaction is off", () => {
    const resolved = resolveRedactOptions({ mode: "off", patterns: defaults });
    const secret = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(secret);
    const lines = [`TOKEN=abcdef1234567890ghij ${secret}`];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("redactSensitiveLines keeps registered secrets when custom regexes are rejected", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: ["/(a+)+$/"] });
    const secret = "opaque-registry-value-1234567890";
    registerSecretValueForRedaction(secret);
    expect(redactSensitiveLines([`TOKEN=abcdef1234567890ghij ${secret}`], resolved)).toEqual([
      "TOKEN=abcdef1234567890ghij opaque…7890",
    ]);
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
});

it("reuses scalar probes only within the current log record", () => {
  const text = "ordinary repeated log fixture 🦞";
  const record = { detail: text, nested: { detail: text } };
  const probe = vi.spyOn(prefilters, "couldMatchDefaultFullContextPatterns");
  const count = () => probe.mock.calls.filter(([input]) => input === text).length;
  try {
    expect(redactLogRecordForTransport(record)).toEqual(record);
    expect(count()).toBe(1);
    expect(redactLogRecordForTransport(record)).toEqual(record);
    expect(count()).toBe(2);
  } finally {
    probe.mockRestore();
  }
});

describe("model-visible structured properties", () => {
  const redact = redactModelVisibleSecrets;
  it("uses current registry masking before reusing an exact text probe", () => {
    const text = "opaque-fixture-value";
    const input = [{ detail: text }, { detail: text }];
    Object.defineProperty(input, 1, {
      get() {
        registerSecretValueForRedaction(text);
        return { detail: text };
      },
    });
    try {
      expect(redact(input)).toEqual([{ detail: text }, { detail: "opaque…alue" }]);
    } finally {
      resetSecretRedactionRegistryForTest();
    }
  });

  it("redacts public share capabilities without treating ordinary ids as secrets", () => {
    const shareId = "a".repeat(48);
    expect(
      redact({
        publicShare: { id: shareId, sessionId: "session-1", createdAt: 1 },
        ordinary: { id: shareId },
      }),
    ).toEqual({
      publicShare: { id: "aaaaaa…aaaa", sessionId: "session-1", createdAt: 1 },
      ordinary: { id: shareId },
    });
  });

  it("preserves JSON prototype-named fields as redacted own data", () => {
    const input = JSON.parse(
      '{"__proto__":{"label":"root","token":"fixture-value"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    const before = JSON.stringify(input);
    const result = redact(input);

    expect(JSON.stringify(result)).toBe(
      '{"__proto__":{"label":"root","token":"***"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    for (const value of [result, result.nested, ...result.items]) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps shared references distinct from cycles and preserves nonplain values", () => {
    const shared = { label: "ordinary", token: "fixture-value" };
    const input: Record<string, unknown> = Object.assign(Object.create(null), {
      first: shared,
      second: shared,
      date: new Date(0),
    });
    input.self = input;
    const result = redact(input);

    expect(result).toEqual({
      first: { label: "ordinary", token: "***" },
      second: { label: "ordinary", token: "***" },
      date: input.date,
      self: "[Circular]",
    });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.date).toBe(input.date);
    expect(result.first).not.toBe(shared);
    expect(shared.token).toBe("fixture-value");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
