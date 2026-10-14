import { expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

// Regression coverage for the shared redactor on long text (GHSA-pm9j-g39c-3x2v):
// 1. whole-text masking — every default rule family masks its synthetic sample when the
//    sample straddles a former 16,384-character slice boundary (and 32,768 / 65,536),
// 2. controls — the same sample stays masked away from any boundary,
// 3. no-throw — multi-megabyte values must not overflow the regex backtrack stack,
// 4. timing — the adversarial run shapes must not stall the event loop,
// 5. scaling — doubling the input must not explode the worst rule's time.
// All values are synthetic and match no real vendor credential.

const FILLER_START = "x";
const FILLER_END = "y";

/**
 * Places `secret` so it straddles `offset`: the secret starts half its length before the
 * offset, surrounded by the sentence halves and filler out to `total` characters.
 */
function placeAt(secret: string, sentence: string, offset: number, total: number): string {
  const [before, after] = sentence.split("@@SECRET@@");
  const leading = before ?? "";
  const trailing = after ?? "";
  const secretStart = Math.max(leading.length + 2, offset - Math.floor(secret.length / 2));
  const prefixFiller = FILLER_START.repeat(secretStart - leading.length - 1);
  const consumed = secretStart + secret.length + trailing.length;
  const suffixFiller = FILLER_END.repeat(Math.max(0, total - consumed - 1));
  return `${prefixFiller} ${leading}${secret}${trailing}${suffixFiller ? ` ${suffixFiller}` : ""}`;
}

function expectMaskedAt(secret: string, sentence: string, offset: number, total: number): void {
  const text = placeAt(secret, sentence, offset, total);
  const output = redactSensitiveText(text, { mode: "tools" });
  expect(output, `family "${sentence}" must not leak across offset ${offset}`).not.toContain(
    secret,
  );
}

const hexRepeat = (count: number, chars = "0123456789abcdef"): string =>
  chars
    .slice(0, 16)
    .repeat(Math.ceil(count / 16))
    .slice(0, count);

const lowerRepeat = (char: string, count: number): string => char.repeat(count);

// One entry per default rule family. The sentence carries @@SECRET@@ where the value sits;
// entries without a template use the secret alone.
const RULE_FAMILY_SAMPLES: readonly (readonly [string, string, string?])[] = [
  // Assignment / structured field families.
  ["env assignment", "API_KEY=example0value0tests"],
  ["escaped env assignment", "API_KEY=\\'escvalue12345'"],
  ["json secret field", '"password": "plainsecretvalue123"'],
  ["json payment field", '"card_number": "4111111111111111"'],
  ["ambiguous quoted field", 'credential: "opaquevalue123456"'],
  ["cli flag equals", "--api-key=opaquevalue1234567"],
  ["cli flag space", "--token opaquevalue12345678"],
  // The AWS sample is split at source level so secret-scanning push protection does not
  // mistake the synthetic fixture value for a real credential; the runtime value is unchanged.
  [
    "aws secret field",
    ['aws_secret_access_key = "', "wJalrXUtnFEMIK7MDENGb"].join("") +
      ["PxRfiCYEXAMPLEKEY0a", '"'].join(""),
  ],
  ["pem block", "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"],
  // Authorization / header families.
  ["authorization bearer", "Authorization: Bearer abcdefghij0123456789"],
  ["authorization basic", "Authorization: Basic dXNlcjpwYXNzd29yZDE"],
  ["authorization bot", "Authorization: Bot abcdefghij012345678"],
  ["authorization opaque scheme", "Authorization: Digest nonce=abcdefgh0123456789"],
  ["authorization opaque tail", "Authorization: plainopaquecred99;"],
  ["proxy-authorization scheme", "Proxy-Authorization: Digest nonce=abcdefgh0123456789"],
  ["proxy-authorization tail", "Proxy-Authorization: plainopaquecred99;"],
  ["credential-style colon header", "api-key: plainopaquevalue12345"],
  ["credential-style equals header", "api-key=plainopaquevalue12345"],
  ["gateway colon header", "X-OpenClaw-Token: plainopaquevalue123"],
  ["gateway equals header", "X-OpenClaw-Token=plainopaquevalue123"],
  ["standalone bearer", "Bearer abcdefghij0123456789"],
  // URL / connection-string families.
  ["url userinfo", ["https", "://user:secretpass@example.com/x"].join("")],
  ["connection string", ["postgres", "://u:secretpass@db.example.com/x"].join("")],
  // Form / config assignment families.
  ["form first pair", "password=abcsecretdef&nextkey=1"],
  ["standalone quoted", 'password="quotedsecretvalue"'],
  ["standalone unquoted", "password=plainsecretvalue12"],
  ["config quoted", 'password: "configsecretvalue"'],
  ["config colon unquoted", "password: configsecretvalue12"],
  ["config equals unquoted", "api-key = cfgsecretvalue12"],
  ["config direct", "access-token=cfgdirectsecret1"],
  ["config prefixed", "db-password: cfgprefixedsecret"],
  ["config namespaced", "smtp.password: cfgnssecret1234"],
  ["bare pass", "pass: opaquepassvalue123", "TODO\n@@SECRET@@\nrest of line"],
  // Vendor token families (synthetic values).
  ["openai sk", "sk-abcdef0123456789"],
  ["github ghp", "ghp_abcdefghij1234567890"],
  ["github gho", "gho_abcdefghij1234567890"],
  ["github pat", "github_pat_abcdefghij1234"],
  ["gitlab glpat", "glpat-abcdefghijklmnopqrst"],
  ["gitlab gloas", `gloas-${hexRepeat(66)}`],
  ["gitlab gldt", "gldt-abcdefghijklmnopqrst"],
  ["gitlab glcbt", "glcbt-abc_abcdefghijklmnopqrst"],
  ["gitlab glptt", `glptt-${lowerRepeat("g", 40)}`],
  ["gitlab glft", "glft-abcdefghijklmnopqrst"],
  ["gitlab glimt", `glimt-${lowerRepeat("h", 25)}`],
  ["gitlab glagent", `glagent-${lowerRepeat("i", 50)}`],
  ["gitlab glwt", "glwt-abcdefghijklmnopqrst"],
  ["gitlab glsoat", "glsoat-abcdefghijklmnopqrst"],
  ["gitlab glffct", "glffct-abcdefghijklmnopqrst"],
  ["gitlab glrt", "glrt-abcdefghijklmnopqrst"],
  ["gitlab gr134", "GR1348941abcdefghijklmnopqrst"],
  ["gitlab session", "_gitlab_session=abcdefghijklmnopqrst"],
  ["slack xoxb", "xoxb-123456789012-abcdefghij"],
  ["slack xapp", "xapp-123456789012-abcdefghij"],
  [
    "slack webhook",
    ["https", "://hooks.slack.com/services/"].join("") +
      ["T", "01234567"].join("") +
      ["/B", "01234567"].join("") +
      ["/", "abcdefghijklmnopqrst"].join(""),
  ],
  [
    "discord webhook",
    `https://discord.com/api/webhooks/123456789012345678/${lowerRepeat("a", 60)}`,
  ],
  ["discord token", `discord ${lowerRepeat("a", 24)}.bbbbbb.${lowerRepeat("c", 27)}`],
  ["grogq gsk", "gsk_abcdefghij12345"],
  ["google aiza", ["AIzaSyA123456", "7890abcdefghij"].join("")],
  ["google ya29", ["ya", "29"].join("") + ".a0123456789"],
  ["google refresh", "1//0a0123456789"],
  ["jwt", "eyJabcdefghij.1234567890.abcdefghij"],
  ["perplexity", "pplx-abcdefghij12345"],
  ["fal", "fal_abcdefghij12345"],
  ["fireworks fc", " fc-abcdefghij12345"],
  ["browserbase", "bb_live_abcdefghij12"],
  ["fuzz gAAAA", "gAAAAabcdefghij0123456789"],
  ["stripe live", "sk_live_abcdefghij12345"],
  ["sendgrid", "SG.abcdefghij1234567.abcdefghij1234567"],
  ["npm", "npm_abcdefghij12345678"],
  ["pypi", "pypi-abcdefghij12345"],
  ["digitalocean", "dop_v1_abcdefghij12345"],
  ["digitalpulse ct", `dp.ct.${lowerRepeat("j", 42)}`],
  ["digitalpulse st", `dp.st.${lowerRepeat("k", 42)}`],
  ["docker pat", "dckr_pat_abcdefghij0123456789abcdefghij"],
  ["bkua", `bkua_${lowerRepeat("b", 40)}`],
  ["ccipat", `CCIPAT_${"C".repeat(22)}_${hexRepeat(40)}`],
  ["sbp", `sbp_${lowerRepeat("d", 40)}`],
  ["datadog", `ddp_${"D".repeat(36)}`],
  ["nfp", `nfp_${"E".repeat(36)}`],
  ["glsa", `glsa_${"F".repeat(41)}`],
  ["glc eyj", `glc_eyJ${"A".repeat(80)}`],
  ["cfpat", `CFPAT-${"G".repeat(40)}`],
  ["bbdc", `BBDC-${"H".repeat(42)}`],
  ["hrku", `HRKU-AA${"I".repeat(20)}`],
  ["planetscale", "pat-eu1-abcdefgh-abcd-abcd-abcd-abcddefghijk"],
  ["apify", "apify_api_abcdefghij1234567890"],
  ["flyv1", `FlyV1 fm123_${"J".repeat(100)}`],
  ["fio", `fio-u-${"K".repeat(40)}`],
  ["alibaba am", " am_abcdefghij12345"],
  ["alibaba sk", " sk_abcdefghij12345"],
  ["tvly", "tvly-abcdefghij12345"],
  ["exa", "exa_abcdefghij12345"],
  ["syt", "syt_abcdefghij12345"],
  ["retaindb", "retaindb_abcdefghij12"],
  ["mem0", "mem0_abcdefghij12345"],
  ["brv", "brv_abcdefghij12345"],
  ["xai", `xai-${"L".repeat(30)}`],
  ["fireworks fw dash", " fw-abcdefghij01234567890123456789"],
  ["fireworks fw score", " fw_abcdefghij01234567890123456789"],
  ["fireworks fpk", " fpk_abcdefghij01234567890123456789"],
  ["hsk", "hsk-abcdefghij12345"],
  ["aws akia", "AKIAABCDEFGHIJKLMNOP"],
  ["aws asia", "ASIAABCDEFGHIJKLMNOP"],
  ["aws akid", "AKIDabcdefghij12345"],
  ["aliyun ltai", "LTAIabcdefghij12345"],
  ["huggingface", "hf_abcdefghij12345"],
  ["api org", "api_org_abcdefghijklmnopqrst"],
  ["r8", "r8_abcdefghij12345"],
  ["atlassian atatt", "ATATTabcdefghij1234567890=12345678"],
  ["atlassian atctt", "ATCTT3xFfGabcdefghij123=12345678"],
  ["atlassian atbb", "ATBBabcdefghij012345"],
  ["dataiku dapi", `dapi${hexRepeat(32)}`],
];

const BOUNDARY_OFFSETS = [16_384, 32_768, 65_536] as const;

it("masks every rule family across former slice boundaries and at the control offset", () => {
  for (const [_name, secret, sentence] of RULE_FAMILY_SAMPLES) {
    const template = sentence ?? "@@SECRET@@ and trailing context";
    for (const offset of BOUNDARY_OFFSETS) {
      const total = Math.max(40_000, offset + 6_000);
      expectMaskedAt(secret, template, offset, total);
    }
    expectMaskedAt(secret, template, 1_000, 40_000);
  }
}, 240_000);

it("keeps the boundary coverage table broad", () => {
  expect(RULE_FAMILY_SAMPLES.length).toBeGreaterThan(90);
});

it("returns multi-megabyte values without throwing", () => {
  expect(() =>
    redactSensitiveText(`Bearer ${"a".repeat(6_000_000)}`, { mode: "tools" }),
  ).not.toThrow();
  const quoted = redactSensitiveText(`password="${"a".repeat(10_500_000)}"`, { mode: "tools" });
  expect(quoted).not.toContain("a".repeat(200));
  expect(() => redactSensitiveText(`sk-${"a".repeat(6_000_000)}`, { mode: "tools" })).not.toThrow();
  expect(() =>
    redactSensitiveText(`gloas-${hexRepeat(3_000_000, "0123456789ABCDEF")}`, { mode: "tools" }),
  ).not.toThrow();
}, 120_000);

it("redacts adversarial run shapes within one second", () => {
  const shapes: readonly (readonly [string, string])[] = [
    ["AKIA-like starts", "+AKIAA".repeat(40_000)],
    ["percent escapes", "%41".repeat(70_000)],
    ["connection strings", "postgres://u:".repeat(16_000)],
    ["opaque auth headers", "Authorization:***".repeat(12_000)],
    ["url userinfo runs", "https://user:".repeat(16_000)],
  ];
  for (const [name, text] of shapes) {
    const started = performance.now();
    redactSensitiveText(text, { mode: "tools" });
    const elapsed = performance.now() - started;
    expect(elapsed, `${name} must not stall`).toBeLessThan(1_000);
  }
}, 60_000);

it("scales without explosion when the input doubles", () => {
  const timed = (units: number): number => {
    const started = performance.now();
    redactSensitiveText("+AKIAA".repeat(units), { mode: "tools" });
    return performance.now() - started;
  };
  const smaller = timed(20_000);
  const larger = timed(40_000);
  expect(larger).toBeLessThan(1_000);
  // Doubling may at most quadruple the cost (plus scheduling slack); explosive growth fails.
  expect(larger).toBeGreaterThan(0);
  expect(larger).toBeLessThan(smaller * 6 + 50);
}, 60_000);
