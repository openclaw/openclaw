import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { z } from "zod";
import {
  AgentModelSchema,
  DecisionModelSchema,
  DecisionModelsByTaskSchema,
} from "./zod-schema.agent-model.js";

export const AgentRuntimePolicySchema = z
  .object({
    id: z.string().optional(),
  })
  .strict()
  .optional();

const AgentModelRuntimeEntrySchema = z
  .object({
    /** Optional display/lookup alias for this provider/model entry. */
    alias: z.string().optional(),
    /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Optional agent execution runtime for this specific provider/model entry. */
    agentRuntime: AgentRuntimePolicySchema,
    /** Additional explicit runtime choices in the model picker; does not change the default. */
    pickerRuntimes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[a-z][a-z0-9-]*$/)
          .refine((id) => id !== "auto" && id !== "default"),
      )
      .max(8)
      .optional(),
    /** OpenClaw Code Mode override; omitted inherits the enclosing activation policy. */
    codeMode: z.boolean().optional(),
    /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
    streaming: z.boolean().optional(),
  })
  .strict();

export const AgentModelMapSchema = z
  .record(z.string(), AgentModelRuntimeEntrySchema)
  .superRefine((models, ctx) => {
    for (const [ref, entry] of Object.entries(models)) {
      if (
        entry.pickerRuntimes !== undefined &&
        (ref.includes("*") || !parseProviderModelRef(ref))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [ref, "pickerRuntimes"],
          message: "Picker runtimes require an exact provider/model entry.",
        });
      }
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
    /** Model refs allowed for session/run overrides. Empty or omitted allows any model. */
    allow: z.array(z.string()).optional(),
  })
  .strict();

const AgentRuntimeAcpSchema = z
  .object({
    /** ACP harness adapter id (for example codex, claude). */
    agent: z.string().optional(),
    /** Optional ACP backend override for this agent runtime. */
    backend: z.string().optional(),
    /** Optional ACP session mode override. */
    mode: z.enum(["persistent", "oneshot"]).optional(),
    /** Optional runtime working directory override. */
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
    decisionModel: DecisionModelSchema.optional(),
    decisionModelsByTask: DecisionModelsByTaskSchema.optional(),
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
    experimental: z
      .object({
        localModelLean: z.boolean().optional(),
      })
      .strict()
      .optional(),
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
