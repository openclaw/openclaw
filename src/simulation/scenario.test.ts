import { describe, expect, it } from "vitest";
import { deriveScenario, parseScenario } from "./scenario.js";

const VALID_YAML = `
name: test-scenario
agents:
  - id: agent-1
    provider: fake
    model: fake-fast
channels:
  - type: telegram
    accounts:
      - id: bot1
conversations:
  - id: conv-1
    channel: telegram
    account: bot1
    peer: group-42
    chatType: group
providers:
  fake:
    models:
      fake-fast:
        latencyMs: 100
        response: "ok"
traffic:
  - conversation: conv-1
    pattern: burst
    count: 5
    intervalMs: 50
    startAtMs: 0
    senderIds:
      - user-1
`;

describe("parseScenario", () => {
  it("parses valid YAML into a ScenarioConfig", () => {
    const config = parseScenario(VALID_YAML);
    expect(config.name).toBe("test-scenario");
    expect(config.agents).toHaveLength(1);
    expect(config.channels).toHaveLength(1);
    expect(config.conversations).toHaveLength(1);
    expect(config.traffic).toHaveLength(1);
    expect(config.traffic[0].pattern).toBe("burst");
  });

  it("rejects invalid YAML (missing required fields)", () => {
    expect(() => parseScenario("name: test")).toThrow();
  });

  it("rejects invalid traffic pattern", () => {
    const yaml = VALID_YAML.replace("burst", "invalid_pattern");
    expect(() => parseScenario(yaml)).toThrow();
  });

  it("accepts optional seed", () => {
    const yaml = `seed: 42\n${VALID_YAML}`;
    const config = parseScenario(yaml);
    expect(config.seed).toBe(42);
  });

  it("accepts optional symptoms configuration", () => {
    const yaml = `${VALID_YAML}\nsymptoms:\n  reply_explosion:\n    maxRatio: 2.0`;
    const config = parseScenario(yaml);
    expect(config.symptoms?.reply_explosion?.maxRatio).toBe(2.0);
  });
});

describe("deriveScenario", () => {
  it("creates a new scenario with overrides", () => {
    const base = parseScenario(VALID_YAML);
    const derived = deriveScenario(base, { name: "derived-test", seed: 99 });
    expect(derived.name).toBe("derived-test");
    expect(derived.seed).toBe(99);
    expect(derived.agents).toEqual(base.agents);
  });
});
