import { expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

it("rejects legacy channel-local ACP bindings", () => {
  const result = OpenClawSchema.safeParse({
    channels: {
      discord: {
        guilds: {
          guild: { channels: { channel: { bindings: { acp: { agentId: "coding" } } } } },
        },
      },
    },
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["channels", "discord", "guilds", "guild", "channels", "channel", "bindings", "acp"],
      }),
    );
  }
});

it("rejects ACP bindings without a concrete peer conversation", () => {
  const result = OpenClawSchema.safeParse({
    bindings: [{ type: "acp", agentId: "coding", match: { channel: "chat-a" } }],
  });
  expect(result.success).toBe(false);
});
