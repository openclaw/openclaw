import { z } from "zod";
import { SUBAGENT_ANNOUNCE_TARGETS } from "../agents/subagent-announce-target.types.js";

export function createAgentEntrySubagentsSchema(agentModelSchema: z.ZodTypeAny) {
  return z
    .object({
      delegationMode: z.enum(["suggest", "prefer"]).optional(),
      allowAgents: z.array(z.string()).optional(),
      model: agentModelSchema.optional(),
      thinking: z.string().optional(),
      announceTarget: z.enum(SUBAGENT_ANNOUNCE_TARGETS).optional(),
      requireAgentId: z.boolean().optional(),
    })
    .strict()
    .optional();
}
