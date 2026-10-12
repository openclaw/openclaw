// Covers authored own "__proto__" data keys surviving env-ref restoration.
// JSON.parse builds the authored own keys; an object literal would write the
// prototype instead of a real own property.
import { describe, it, expect } from "vitest";
import { restoreEnvVarRefs } from "./env-preserve.js";

describe("restoreEnvVarRefs with authored own __proto__ keys", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-api03-real-key",
    MY_TOKEN: "tok-12345",
  };

  it("keeps an authored own __proto__ key as inert data when nothing matches", () => {
    const incoming = JSON.parse(
      '{"apiKey":"sk-ant-new-different-key","__proto__":{"injected":true}}',
    ) as Record<string, unknown>;
    const parsed = JSON.parse('{"apiKey":"${ANTHROPIC_API_KEY}"}');
    const result = restoreEnvVarRefs(incoming, parsed, env) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result).toEqual(incoming);
  });

  it("restores a reference under an authored own __proto__ key", () => {
    const incoming = JSON.parse('{"__proto__":{"token":"tok-12345"}}') as Record<string, unknown>;
    const parsed = JSON.parse('{"__proto__":{"token":"${MY_TOKEN}"}}');
    const result = restoreEnvVarRefs(incoming, parsed, env) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result).toEqual(JSON.parse('{"__proto__":{"token":"${MY_TOKEN}"}}'));
  });

  it("restores references across an unchanged two-row array with authored own __proto__ keys", () => {
    // The comparison tree has to settle each row's own "__proto__" key as
    // inert data, or neither row equals its resolved counterpart and the
    // array identities cannot match.
    const parsed = JSON.parse(
      '{"providers":[' +
        '{"id":"alpha","token":"${MY_TOKEN}","__proto__":null},' +
        '{"id":"beta","token":"${MY_TOKEN}","__proto__":null}' +
        "]}",
    ) as { providers: Array<Record<string, unknown>> };
    const incoming = JSON.parse(
      '{"providers":[' +
        '{"id":"alpha","token":"tok-12345","__proto__":null},' +
        '{"id":"beta","token":"tok-12345","__proto__":null}' +
        "]}",
    ) as { providers: Array<Record<string, unknown>> };

    const result = restoreEnvVarRefs(incoming, parsed, env) as typeof parsed;
    expect(result.providers.map((row) => row.id)).toEqual(["alpha", "beta"]);
    expect(result).toEqual(parsed);
    for (const row of result.providers) {
      expect(row.token).toBe("${MY_TOKEN}");
      const authoredKey = Object.getOwnPropertyDescriptor(row, "__proto__");
      expect(authoredKey?.value).toBeNull();
      expect(authoredKey?.enumerable).toBe(true);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    }
  });
});
