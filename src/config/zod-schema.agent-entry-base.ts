import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { z } from "zod";
import { AgentModelSchema } from "./zod-schema.agent-model.js";

const AgentRuntimePolicySchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .optional();

const AgentModelRuntimeEntrySchema = z
  .object({
    alias: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    agentRuntime: AgentRuntimePolicySchema,
    codeMode: z.boolean().optional(),
    streaming: z.boolean().optional(),
  })
  .strict();

export const AgentModelMapSchema = z
  .record(z.string(), AgentModelRuntimeEntrySchema)
  .superRefine((models, ctx) => {
    for (const [ref, entry] of Object.entries(models)) {
      if (entry.codeMode !== undefined && (ref.includes("*") || !parseProviderModelRef(ref))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [ref, "codeMode"],
          message:
            "Code Mode requires an exact provider/model entry; wildcard and bare model keys are not supported.",
        });
      }
    }
  });

export const AgentModelPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
  })
  .strict();

const AgentRuntimeAcpSchema = z
  .object({
    agent: z.string().optional(),
    backend: z.string().optional(),
    mode: z.enum(["persistent", "oneshot"]).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .optional();

const AgentRuntimeSchema = z
  .union([
    z.object({ type: z.literal("embedded") }).strict(),
    z.object({ type: z.literal("acp"), acp: AgentRuntimeAcpSchema }).strict(),
  ])
  .optional();

const AgentEntryEmbeddedAgentConfigSchema = z
  .object({
    executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
  })
  .strict()
  .optional();

export const AgentEntryBaseSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    workspace: z.string().optional(),
    cwd: z.string().optional(),
    agentDir: z.string().optional(),
    model: AgentModelSchema.optional(),
    utilityModel: z.string().optional(),
    models: AgentModelMapSchema.optional(),
    modelPolicy: AgentModelPolicySchema.optional(),
    thinkingDefault: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"])
      .optional(),
    verboseDefault: z.enum(["off", "on", "full"]).optional(),
    toolProgressDetail: z.enum(["explain", "raw"]).optional(),
    reasoningDefault: z.enum(["on", "off", "stream"]).optional(),
    fastModeDefault: z.union([z.boolean(), z.literal("auto")]).optional(),
    contextInjection: z
      .union([z.literal("always"), z.literal("continuation-skip"), z.literal("never")])
      .optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    bootstrapTotalMaxChars: z.number().int().positive().optional(),
    experimental: z.object({ localModelLean: z.boolean().optional() }).strict().optional(),
    skills: z.array(z.string()).optional(),
    subagents: z
      .object({
        delegationMode: z.enum(["suggest", "prefer"]).optional(),
        allowAgents: z.array(z.string()).optional(),
        model: AgentModelSchema.optional(),
        thinking: z.string().optional(),
        requireAgentId: z.boolean().optional(),
      })
      .strict()
      .optional(),
    embeddedAgent: AgentEntryEmbeddedAgentConfigSchema,
    params: z.record(z.string(), z.unknown()).optional(),
    runtime: AgentRuntimeSchema,
  })
  .strict();
