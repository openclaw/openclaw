import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config validation allowed-values metadata", () => {
  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "update.channel");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('(allowed: "stable", "beta", "dev")');
      expect(issue?.allowedValues).toEqual(["stable", "beta", "dev"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("keeps native enum messages while attaching allowed values metadata", () => {
    const result = validateConfigObjectRaw({
      channels: { signal: { dmPolicy: "maybe" } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.signal.dmPolicy");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("expected one of");
      expect(issue?.message).not.toContain("(allowed:");
      expect(issue?.allowedValues).toEqual(["pairing", "allowlist", "open", "disabled"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("includes boolean variants for boolean-or-enum unions", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "x",
          allowFrom: ["*"],
          dmPolicy: "allowlist",
          streaming: "maybe",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.telegram");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(
        "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy",
      );
      expect(issue?.allowedValues).toBeUndefined();
    }
  });

  it("skips allowed-values hints for unions with open-ended branches", () => {
    const result = validateConfigObjectRaw({
      cron: { sessionRetention: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "cron.sessionRetention");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
      expect(issue?.allowedValuesHiddenCount).toBeUndefined();
      expect(issue?.message).not.toContain("(allowed:");
    }
  });

  it("surfaces specific sub-issue for invalid_union bindings errors instead of generic 'Invalid input'", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          type: "acp",
          agentId: "test",
          match: { channel: "discord", peer: { kind: "direct", id: "123" } },
          acp: { agent: "claude" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        path: "bindings.0",
        message: "Invalid input",
      });
      expect(result.issues).toContainEqual({
        path: "bindings.0.acp",
        message: 'Unrecognized key: "agent"',
      });
    }
  });

  it("prefers the matching union branch for top-level unexpected keys", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          type: "acp",
          agentId: "test",
          match: { channel: "discord", peer: { kind: "direct", id: "123" } },
          acp: { mode: "persistent" },
          extraTopLevel: true,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        path: "bindings.0.type",
        message: 'Invalid input: expected "route"',
      });
      expect(result.issues).toContainEqual({
        path: "bindings.0",
        message: 'Unrecognized key: "extraTopLevel"',
      });
    }
  });

  it("keeps generic union messaging for mixed scalar-or-object unions", () => {
    const result = validateConfigObjectRaw({
      agents: {
        list: [{ id: "a", model: true }],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).not.toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input: expected string, received boolean",
      });
      expect(result.issues).not.toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input: expected object, received boolean",
      });
      expect(result.issues).toContainEqual({
        path: "agents.list.0.model",
        message: "Invalid input",
      });
    }
  });
});
