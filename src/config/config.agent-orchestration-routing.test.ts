import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("config agents.orchestration", () => {
  it("accepts routing aliases and orchestration policy", () => {
    const res = OpenClawSchema.safeParse({
      agents: {
        orchestration: {
          routingAliases: [
            {
              agentId: "rail-business",
              aliases: ["rail", "wagon", "wagons"],
              description: "Rail business specialist",
              routingHints: ["freight", "repairs"],
            },
          ],
          policy: {
            defaultBehavior: "orchestrate",
            fallbackBehavior: "self-answer",
            directRoutingMode: "hint",
            allowMultiAgentDelegation: true,
            preserveUserVisibleSingleChat: true,
          },
        },
      },
    });
    expect(res.success).toBe(true);
  });
});
