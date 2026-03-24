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
          communication: {
            allowDirectSpecialistToSpecialist: false,
            requireStructuredHandoff: true,
            requireStructuredReturn: true,
            allowParallelDelegation: true,
          },
          limits: {
            maxDelegationDepth: 2,
            maxAgentsPerRequest: 3,
            dedupeRepeatedHandoffs: true,
            stopWhenNoNewInformation: true,
          },
          handoffEnvelope: { enabled: true },
          responseEnvelope: { enabled: true },
        },
      },
    });
    expect(res.success).toBe(true);
  });
});
