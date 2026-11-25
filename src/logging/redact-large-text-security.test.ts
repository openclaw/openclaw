import { readFileSync } from "node:fs";
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

// Reuse the recorded family corpus owned by redact-byte-identity.test.ts.
const corpus: { cases: [string, string, string][] } = JSON.parse(
  readFileSync(new URL("./redact-prefilter-fixture.json", import.meta.url), "utf8"),
);
const ruleFamilies = corpus.cases
  .filter(([name]) => name.startsWith("family/") && name.split("/").length === 2)
  .map(([name, sample]): [string, string] => {
    const text = sample.replace(/@@S/g, ":");
    return name === "family/bare pass"
      ? [text.slice("TODO\n".length, -"\nrest of line".length), "TODO\n@@SECRET@@\nrest of line"]
      : [text, "@@SECRET@@ and trailing context"];
  });

it("masks every rule family across former slice boundaries and at the control offset", () => {
  for (const [secret, sentence] of ruleFamilies) {
    // An isolated token must reach the prefilter without another credential marker.
    const standalone = secret.trimStart();
    expect(redact(standalone)).not.toContain(standalone);
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
