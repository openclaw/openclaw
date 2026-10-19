import { expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

// GHSA-pm9j-g39c-3x2v: synthetic credentials straddle former slice boundaries.
function expectMaskedAt(secret: string, sentence: string, offset: number, total: number): void {
  const [leading = "", trailing = ""] = sentence.split("@@SECRET@@");
  const secretStart = Math.max(leading.length + 2, offset - Math.floor(secret.length / 2));
  const prefixFiller = "x".repeat(secretStart - leading.length - 1);
  const consumed = secretStart + secret.length + trailing.length;
  const suffixFiller = "y".repeat(Math.max(0, total - consumed - 1));
  const output = redact(
    `${prefixFiller} ${leading}${secret}${trailing}${suffixFiller ? ` ${suffixFiller}` : ""}`,
  );
  expect(output, `family "${sentence}" must not leak across offset ${offset}`).not.toContain(
    secret,
  );
}

const hexRepeat = (count: number, chars = "0123456789abcdef"): string =>
  chars.repeat(Math.ceil(count / 16)).slice(0, count);
const redact = (text: string) => redactSensitiveText(text, { mode: "tools" });
function elapsed(text: string) {
  const started = performance.now();
  redact(text);
  return performance.now() - started;
}

const tokenSamples = (prefixes: string, suffix: string) =>
  prefixes.split("|").map((prefix): readonly [string, string] => [prefix, prefix + suffix]);

// Each row exercises a default rule family, with an optional sentence template.
const RULE_FAMILY_SAMPLES: readonly (readonly [string, string, string?])[] = [
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
  ["url userinfo", ["https", "://user:secretpass@example.com/x"].join("")],
  ["connection string", ["postgres", "://u:secretpass@db.example.com/x"].join("")],
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
  ...tokenSamples(
    "gsk_|pplx-|fal_| fc-|sk_live_|pypi-|dop_v1_| am_| sk_|tvly-|exa_|syt_|mem0_|brv_|hsk-|AKID|LTAI|hf_|r8_",
    "abcdefghij12345",
  ),
  ...tokenSamples(
    "glpat-|gldt-|glft-|glwt-|glsoat-|glffct-|glrt-|_gitlab_session=|api_org_",
    "abcdefghijklmnopqrst",
  ),
  ["openai sk", "sk-abcdef0123456789"],
  ["github ghp", "ghp_abcdefghij1234567890"],
  ["github gho", "gho_abcdefghij1234567890"],
  ["github pat", "github_pat_abcdefghij1234"],
  ["gitlab gloas", `gloas-${hexRepeat(66)}`],
  ["gitlab glcbt", "glcbt-abc_abcdefghijklmnopqrst"],
  ["gitlab glptt", `glptt-${"g".repeat(40)}`],
  ["gitlab glimt", `glimt-${"h".repeat(25)}`],
  ["gitlab glagent", `glagent-${"i".repeat(50)}`],
  ["gitlab gr134", "GR1348941abcdefghijklmnopqrst"],
  ["slack xoxb", "xoxb-123456789012-abcdefghij"],
  ["slack xapp", "xapp-123456789012-abcdefghij"],
  [
    "slack webhook",
    ["https", "://hooks.slack.com/services/"].join("") +
      ["T", "01234567"].join("") +
      ["/B", "01234567"].join("") +
      ["/", "abcdefghijklmnopqrst"].join(""),
  ],
  ["discord webhook", `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(60)}`],
  ["discord token", `discord ${"a".repeat(24)}.bbbbbb.${"c".repeat(27)}`],
  ["google aiza", ["AIzaSyA123456", "7890abcdefghij"].join("")],
  ["google ya29", ["ya", "29"].join("") + ".a0123456789"],
  ["google refresh", "1//0a0123456789"],
  ["jwt", "eyJabcdefghij.1234567890.abcdefghij"],
  ["browserbase", "bb_live_abcdefghij12"],
  ["fuzz gAAAA", "gAAAAabcdefghij0123456789"],
  ["sendgrid", "SG.abcdefghij1234567.abcdefghij1234567"],
  ["npm", "npm_abcdefghij12345678"],
  ["digitalpulse ct", `dp.ct.${"j".repeat(42)}`],
  ["digitalpulse st", `dp.st.${"k".repeat(42)}`],
  ["docker pat", "dckr_pat_abcdefghij0123456789abcdefghij"],
  ["bkua", `bkua_${"b".repeat(40)}`],
  ["ccipat", `CCIPAT_${"C".repeat(22)}_${hexRepeat(40)}`],
  ["sbp", `sbp_${"d".repeat(40)}`],
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
  ["retaindb", "retaindb_abcdefghij12"],
  ["xai", `xai-${"L".repeat(30)}`],
  ["fireworks fw dash", " fw-abcdefghij01234567890123456789"],
  ["fireworks fw score", " fw_abcdefghij01234567890123456789"],
  ["fireworks fpk", " fpk_abcdefghij01234567890123456789"],
  ["aws akia", "AKIAABCDEFGHIJKLMNOP"],
  ["aws asia", "ASIAABCDEFGHIJKLMNOP"],
  ["atlassian atatt", "ATATTabcdefghij1234567890=12345678"],
  ["atlassian atctt", "ATCTT3xFfGabcdefghij123=12345678"],
  ["atlassian atbb", "ATBBabcdefghij012345"],
  ["dataiku dapi", `dapi${hexRepeat(32)}`],
];

it("masks every rule family across former slice boundaries and at the control offset", () => {
  for (const [_name, secret, sentence] of RULE_FAMILY_SAMPLES) {
    const template = sentence ?? "@@SECRET@@ and trailing context";
    for (const offset of [16_384, 32_768, 65_536]) {
      const total = Math.max(40_000, offset + 6_000);
      expectMaskedAt(secret, template, offset, total);
    }
    expectMaskedAt(secret, template, 1_000, 40_000);
  }
}, 240_000);

it("returns multi-megabyte values without throwing", () => {
  expect(() => redact(`Bearer ${"a".repeat(6_000_000)}`)).not.toThrow();
  const quoted = redact(`password="${"a".repeat(10_500_000)}"`);
  expect(quoted).not.toContain("a".repeat(200));
  expect(() => redact(`sk-${"a".repeat(6_000_000)}`)).not.toThrow();
  expect(() => redact(`gloas-${hexRepeat(3_000_000, "0123456789ABCDEF")}`)).not.toThrow();
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
    expect(elapsed(text), `${name} must not stall`).toBeLessThan(1_000);
  }
}, 60_000);

it("scales without explosion when the input doubles", () => {
  const smaller = elapsed("+AKIAA".repeat(20_000));
  const larger = elapsed("+AKIAA".repeat(40_000));
  expect(larger).toBeLessThan(1_000);
  expect(larger).toBeGreaterThan(0);
  expect(larger).toBeLessThan(smaller * 6 + 50);
}, 60_000);
