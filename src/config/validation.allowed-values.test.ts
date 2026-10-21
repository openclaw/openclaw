import { assert, describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation-core.js";

function issues(config: unknown) {
  const result = validateConfigObjectRaw(config);
  assert(!result.ok, "expected invalid config");
  return result.issues;
}

function issueAt(config: unknown, path: string) {
  const issue = issues(config).find((entry) => entry.path === path);
  assert(issue, "expected validation issue at " + path);
  return issue;
}

describe("config validation allowed-values metadata", () => {
  it("does not infer allowed values from user text in collected config issues", () => {
    const text = 'expected one of "bogus"';
    const config = {
      agents: { entries: { main: {} } },
      bindings: [{ agentId: text, match: { channel: "discord" } }],
      broadcast: { "discord:qa": [text] },
      talk: { agentId: text, provider: text, providers: { qa: {} } },
    };
    const original = structuredClone(config);
    const result = issues(config);
    expect(result.map((issue) => issue.path).toSorted()).toEqual([
      "bindings.0.agentId",
      "broadcast.discord:qa.0",
      "talk.agentId",
      "talk.provider",
    ]);
    for (const issue of result) {
      expect(issue.message).toContain(text);
      expect(issue.allowedValues).toBeUndefined();
      expect(issue.allowedValuesHiddenCount).toBeUndefined();
    }
    expect(config).toEqual(original);
  });

  it("adds allowed values and non-enumerable path segments for invalid unions", () => {
    const issue = issueAt({ update: { channel: "nightly" } }, "update.channel");
    expect(issue.pathSegments).toEqual(["update", "channel"]);
    expect(JSON.stringify(issue)).not.toContain("pathSegments");
    expect(issue.message).toContain('(allowed: "stable", "extended-stable", "beta", "dev")');
    expect(issue.allowedValues).toEqual(["stable", "extended-stable", "beta", "dev"]);
    expect(issue.allowedValuesHiddenCount).toBe(0);
  });

  it("skips allowed-values hints for open-ended unions", () => {
    const issue = issueAt({ cron: { sessionRetention: true } }, "cron.sessionRetention");
    expect(issue.allowedValues).toBeUndefined();
    expect(issue.allowedValuesHiddenCount).toBeUndefined();
    expect(issue.message).not.toContain("(allowed:");
  });

  it("adds an exclusive lower-bound hint", () => {
    const issue = issueAt(
      { agents: { defaults: { maxConcurrent: 0 } } },
      "agents.defaults.maxConcurrent",
    );
    expect(issue.message).toContain("(must be greater than 0)");
  });

  it("selects the matching ACP union branch at bindings.0.acp", () => {
    const binding = {
      type: "acp",
      agentId: "test",
      match: { channel: "discord", peer: { kind: "direct", id: "123" } },
      acp: { agent: "claude" },
    };
    expect(issues({ bindings: [binding] })).toEqual([
      { path: "bindings.0.acp", message: 'Unrecognized key: "agent"' },
    ]);
  });

  it("names the replacement for a removed provider and model API", () => {
    const api = "openai-codex-responses";
    const providerConfig = { api, models: [{ id: "gpt-5.5", api }] };
    const result = issues({ models: { providers: { "openai-codex": providerConfig } } });
    const provider = result.find((issue) => issue.path === "models.providers.openai-codex.api");
    expect(provider?.message).toContain('"openai-codex-responses" is a removed api id');
    expect(provider?.message).toContain('use "openai-chatgpt-responses"');
    expect(
      result.find((issue) => issue.path === "models.providers.openai-codex.models.0.api")?.message,
    ).toContain('use "openai-chatgpt-responses"');
  });
});
