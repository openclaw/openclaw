// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ConfigSnapshot } from "../../api/types.ts";
import { skillApiKeyReplaceable, storedSkillApiKeySource } from "../skills/api-key-source.ts";
import { gatewaySnapshot } from "./stored-secret-source.test-support.ts";
import { storedSecretSource } from "./stored-secret-source.ts";

const skillKey = "ops.team";
const path = ["skills", "entries", skillKey, "apiKey"];
const authored = (apiKey: unknown) => ({ skills: { entries: { [skillKey]: { apiKey } } } });
const literal = { kind: "literal" };
const reference = { kind: "reference" };

describe("stored skill key provenance from Gateway redaction", () => {
  it.each([
    ["literal", "plain-token-not-real", literal],
    ["standalone environment", "${SET_TOKEN}", { kind: "environment", name: "SET_TOKEN" }],
    ["SecretRef", { source: "env", provider: "default", id: "SET_TOKEN" }, reference],
    ["interpolation", "Bearer ${SET_TOKEN}", reference],
    ["missing interpolation", "Bearer ${UNSET_TOKEN}", reference],
    ["escaped interpolation", "Bearer $${SET_TOKEN}", reference],
  ])("classifies %s without treating resolved redaction as plaintext", (_name, value, source) => {
    const snapshot = gatewaySnapshot(authored(value));
    expect(storedSecretSource(snapshot, path)).toEqual(source);
    expect(storedSkillApiKeySource(snapshot, skillKey)).toEqual(source);
    expect(skillApiKeyReplaceable(snapshot, skillKey)).toBe(source === literal);
  });

  it("keeps nested included keys and unrelated literals read-only", () => {
    const snapshot = gatewaySnapshot(
      { ...authored("plain-token-not-real"), channels: { $include: "./channels.json5" } },
      { "channels.json5": { discord: { token: "included-not-real" } } },
    );
    expect(skillApiKeyReplaceable(snapshot, skillKey)).toBe(false);
    const included = gatewaySnapshot(
      { skills: { entries: { $include: "./skills.json5" } } },
      { "skills.json5": { [skillKey]: { apiKey: "included-not-real" } } },
    );
    expect(skillApiKeyReplaceable(included, skillKey)).toBe(false);
  });

  it.each(["skills", 'skills.entries["ops.team"]', 'skills.entries["ops.team"].apiKey.id'])(
    "does not infer a literal across a warning at %s",
    (warningPath) => {
      const snapshot = gatewaySnapshot(authored("plain-token-not-real"));
      snapshot.warnings = [{ path: warningPath, message: "Unresolved configuration" }];
      expect(storedSecretSource(snapshot, path)).toEqual(reference);
    },
  );

  it("uses the Gateway spelling for a warning at a dotted skill key", () => {
    const snapshot = gatewaySnapshot(authored("Bearer ${UNSET_TOKEN}"));
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ path: 'skills.entries["ops.team"].apiKey' }),
    ]);
    expect(skillApiKeyReplaceable(snapshot, skillKey)).toBe(false);
  });

  it("distinguishes a proven absent key from an unusable snapshot", () => {
    for (const config of [{}, { skills: { entries: { [skillKey]: { enabled: true } } } }]) {
      const snapshot = gatewaySnapshot(config);
      expect(storedSkillApiKeySource(snapshot, skillKey)).toBeNull();
      expect(skillApiKeyReplaceable(snapshot, skillKey)).toBe(true);
    }
    for (const snapshot of [null, {}, { valid: false, config: {} }, { valid: true, config: {} }]) {
      expect(storedSkillApiKeySource(snapshot, skillKey)).toBeUndefined();
      expect(skillApiKeyReplaceable(snapshot, skillKey)).toBeUndefined();
    }
  });

  it("refuses incomplete or inconsistent evidence even with a redacted value", () => {
    const snapshot = gatewaySnapshot(authored("plain-token-not-real"));
    const overrides: Partial<ConfigSnapshot>[] = [
      { raw: null },
      { raw: undefined },
      { raw: "" },
      { parsed: undefined },
      { valid: false },
      { valid: undefined },
      { includedPaths: ["/fixture/other.json5"] },
      { sourceConfig: authored({ source: "env", provider: "default", id: "SET_TOKEN" }) },
    ];
    for (const override of overrides) {
      expect(skillApiKeyReplaceable({ ...snapshot, ...override }, skillKey)).not.toBe(true);
    }
  });
});
