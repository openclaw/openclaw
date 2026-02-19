import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { SocietyOfMindsOrchestrator } from "../society-of-minds/orchestrator.js";
import type { SocietyOfMindsTask } from "../society-of-minds/types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SocietyOfMindsToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  strategy: optionalStringEnum(["parallel", "sequential", "debate"] as const),
  models: Type.Optional(Type.Array(Type.String())),
  synthesisModel: Type.Optional(Type.String()),
  maxConcurrent: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

export function createSocietyOfMindsTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Society of Minds",
    name: "society_of_minds",
    description:
      "Execute a task using multiple AI models working together (Society of Minds pattern). Models collaborate in parallel, sequential, or debate mode, then results are synthesized into a unified response.",
    parameters: SocietyOfMindsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const task = readStringParam(params, "task", { required: true });
      const label = typeof params.label === "string" ? params.label.trim() : undefined;
      const strategy = readStringParam(params, "strategy") as
        | "parallel"
        | "sequential"
        | "debate"
        | undefined;
      const models =
        Array.isArray(params.models) && params.models.every((m) => typeof m === "string")
          ? params.models
          : undefined;
      const synthesisModel = readStringParam(params, "synthesisModel");
      const maxConcurrent =
        typeof params.maxConcurrent === "number" &&
        Number.isFinite(params.maxConcurrent) &&
        params.maxConcurrent >= 1 &&
        params.maxConcurrent <= 10
          ? Math.floor(params.maxConcurrent)
          : undefined;

      const societyTask: SocietyOfMindsTask = {
        task,
        label,
        strategy,
        models,
        synthesisModel,
        maxConcurrent,
      };

      const orchestrator = new SocietyOfMindsOrchestrator({
        agentSessionKey: opts?.agentSessionKey,
        agentChannel: opts?.agentChannel,
        agentAccountId: opts?.agentAccountId,
        agentTo: opts?.agentTo,
        agentThreadId: opts?.agentThreadId,
        agentGroupId: opts?.agentGroupId,
        agentGroupChannel: opts?.agentGroupChannel,
        agentGroupSpace: opts?.agentGroupSpace,
        requesterAgentIdOverride: opts?.requesterAgentIdOverride,
      });

      const result = await orchestrator.execute(societyTask);

      return jsonResult(result);
    },
  };
}
