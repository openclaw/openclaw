import { describe, expect, it } from "vitest";
import { expectSchemaConfigValue } from "./legacy-config-detection.test-support.js";
import { BindingsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

function expectInvalidWithoutMutation(params: {
  config: unknown;
  expectedPath?: string;
  expectedMessageIncludes?: string;
}) {
  const before = JSON.stringify(params.config);
  const res = OpenClawSchema.safeParse(params.config);
  expect(res.success).toBe(false);
  if (!res.success) {
    if (params.expectedPath !== undefined) {
      expect(res.error.issues[0]?.path.join(".")).toBe(params.expectedPath);
    }
    if (params.expectedMessageIncludes !== undefined) {
      expect(res.error.issues[0]?.message).toContain(params.expectedMessageIncludes);
    }
  }
  expect(JSON.stringify(params.config)).toBe(before);
}

describe("legacy config detection", () => {
  it("rejects legacy agent.model string", () => {
    const res = OpenClawSchema.safeParse({ agent: { model: "anthropic/claude-opus-4-6" } });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("");
      expect(res.error.issues[0]?.message).toContain('"agent"');
    }
  });

  it.each([
    {
      name: "removed legacy provider sections",
      config: { whatsapp: { allowFrom: ["+1555"] } },
      expectedPath: "",
      expectedMessageIncludes: '"whatsapp"',
    },
    {
      name: "bindings[].match.provider",
      config: { bindings: [{ agentId: "main", match: { provider: "slack" } }] },
    },
    {
      name: "bindings[].match.accountID",
      config: {
        bindings: [{ agentId: "main", match: { channel: "telegram", accountID: "work" } }],
      },
    },
    {
      name: "session.sendPolicy.rules[].match.provider",
      config: {
        session: { sendPolicy: { rules: [{ action: "deny", match: { provider: "telegram" } }] } },
      },
    },
    {
      name: "messages.queue.byProvider",
      config: { messages: { queue: { byProvider: { whatsapp: "queue" } } } },
    },
    {
      name: "retired messages.queue.mode",
      config: { messages: { queue: { mode: "queue" } } },
      expectedPath: "messages.queue.mode",
    },
  ])("rejects $name without mutating the source", (params) => {
    expectInvalidWithoutMutation(params);
  });

  it("preserves claude-cli auth profile mode during validation", () => {
    const config = {
      auth: { profiles: { "anthropic:claude-cli": { provider: "anthropic", mode: "token" } } },
    };
    const res = OpenClawSchema.safeParse(config);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("token");
    }
    expect(config.auth.profiles["anthropic:claude-cli"].mode).toBe("token");
  });

  it("accepts bindings[].comment during validation", () => {
    expectSchemaConfigValue({
      schema: BindingsSchema,
      config: [{ agentId: "main", comment: "primary route", match: { channel: "telegram" } }],
      readValue: (config) => (config as Array<{ comment?: string }> | undefined)?.[0]?.comment,
      expectedValue: "primary route",
    });
  });
});
