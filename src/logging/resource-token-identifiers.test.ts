import { afterEach, describe, expect, it } from "vitest";
import {
  redactModelVisibleSecrets,
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactSecrets,
  redactSensitiveFieldValueWithConfig,
} from "./redact.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

afterEach(() => resetSecretRedactionRegistryForTest());

const identifier = "SampleResourceIdentifier1234567890";
const resourceKeys = ["doc_token", "node_token", "obj_token", "page_token", "spreadsheet_token"];

describe.each(resourceKeys)("model-visible resource identifier %s", (key) => {
  it("preserves nested tool references while diagnostic fields stay masked", () => {
    const payload = { nested: [{ [key]: identifier, access_token: identifier }] as const };
    const result = redactModelVisibleSecrets(payload);
    expect(result.nested[0][key]).toBe(identifier);
    expect(result.nested[0].access_token).not.toContain(identifier);
    expect(redactSecrets(payload).nested[0][key]).not.toContain(identifier);
    expect(redactSensitiveFieldValueWithConfig(key, identifier, {})).not.toContain(identifier);
    expect(redactModelVisibleSensitiveFieldValueWithConfig(key, identifier, {})).toBe(identifier);
  });

  it("keeps resource-keyed arrays sensitive", () => {
    const result = redactModelVisibleSecrets({ [key]: [identifier, [identifier]] });
    expect(JSON.stringify(result)).not.toContain(identifier);
  });

  it("still masks a registered secret under a resource field", () => {
    registerSecretValueForRedaction(identifier);
    expect(redactModelVisibleSecrets({ [key]: identifier })[key]).not.toContain(identifier);
    expect(redactModelVisibleSensitiveFieldValueWithConfig(key, identifier, {})).not.toContain(
      identifier,
    );
  });

  it("does not exempt a resource field nested under a credential container", () => {
    const result = redactModelVisibleSecrets({
      access_token: { nested: [{ [key]: identifier }] },
    });
    expect(JSON.stringify(result)).not.toContain(identifier);
  });

  it("still scans resource values with the strict credential patterns", () => {
    const credential = "sk-" + "SYNTHETIC".repeat(8);
    expect(redactModelVisibleSecrets({ [key]: credential })[key]).not.toContain(credential);
    // Ambiguous assignments are normally retained in model-visible source text,
    // but a token-shaped structured field must retain the stricter value scan.
    expect(
      redactModelVisibleSecrets({ [key]: "MY_TOKEN=opaque-fixture-credential" })[key],
    ).not.toContain("opaque-fixture-credential");
  });

  it("honors custom redaction patterns", () => {
    expect(
      redactModelVisibleSensitiveFieldValueWithConfig(key, identifier, {
        redactPatterns: [identifier],
      }),
    ).not.toContain(identifier);
  });
});

it.each([
  "access_token",
  "refresh_token",
  "tenant_access_token",
  "appSecret",
  "api_key",
  "DOC_TOKEN",
  "Doc_Token",
  "doc-token",
  "other_token",
])("keeps credentials and non-resource field %s masked", (key) => {
  expect(redactModelVisibleSecrets({ [key]: identifier })[key]).not.toContain(identifier);
});
