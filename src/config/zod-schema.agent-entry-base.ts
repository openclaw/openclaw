import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { z } from "zod";
import { ALL_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import { AgentModelSchema, DecisionModelSchema } from "./zod-schema.agent-model.js";

export const AgentRuntimePolicySchema = z
  .strictObject({
    id: z.string().optional(),
  })
  .optional();

const AgentModelRuntimeEntrySchema = z.strictObject({
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
});

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

export const AgentModelPolicySchema = z.strictObject({
  /** Model refs allowed for session/run overrides. Empty or omitted allows any model. */
  allow: z.array(z.string()).optional(),
});

const AgentRuntimeAcpSchema = z
  .strictObject({
    /** ACP harness adapter id (for example codex, claude). */
    agent: z.string().optional(),
    /** Optional ACP backend override for this agent runtime. */
    backend: z.string().optional(),
    /** Optional ACP session mode override. */
    mode: z.enum(["persistent", "oneshot"]).optional(),
    /** Optional runtime working directory override. */
    cwd: z.string().optional(),
  })
  .optional();

const AgentRuntimeSchema = z
  .union([
    z.strictObject({ type: z.literal("embedded") }),
    z.strictObject({ type: z.literal("acp"), acp: AgentRuntimeAcpSchema }),
  ])
  .optional();

const AgentEntryEmbeddedAgentConfigSchema = z
  .strictObject({
    executionContract: z.union([z.literal("default"), z.literal("strict-agentic")]).optional(),
  })
  .optional();

export const AgentEntryBaseSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  workspace: z.string().optional(),
  cwd: z.string().optional(),
  agentDir: z.string().optional(),
  model: AgentModelSchema.optional(),
  utilityModel: z.string().optional(),
  decisionModel: DecisionModelSchema.optional(),
  models: AgentModelMapSchema.optional(),
  modelPolicy: AgentModelPolicySchema.optional(),
  thinkingDefault: z.enum(ALL_THINKING_LEVELS).optional(),
  verboseDefault: z.enum(["off", "on", "full"]).optional(),
  toolProgressDetail: z.enum(["explain", "raw"]).optional(),
  reasoningDefault: z.enum(["on", "off", "stream"]).optional(),
  fastModeDefault: z.union([z.boolean(), z.literal("auto"), z.literal("ultrafast")]).optional(),
  contextInjection: z
    .union([z.literal("always"), z.literal("continuation-skip"), z.literal("never")])
    .optional(),
  bootstrapMaxChars: z.number().int().positive().optional(),
  bootstrapTotalMaxChars: z.number().int().positive().optional(),
  experimental: z
    .strictObject({
      localModelLean: z.boolean().optional(),
    })
    .optional(),
  skills: z.array(z.string()).optional(),
  subagents: z
    .strictObject({
      delegationMode: z.enum(["suggest", "prefer"]).optional(),
      allowAgents: z.array(z.string()).optional(),
      model: AgentModelSchema.optional(),
      thinking: z.string().optional(),
      requireAgentId: z.boolean().optional(),
    })
    .optional(),
  embeddedAgent: AgentEntryEmbeddedAgentConfigSchema,
  params: z.record(z.string(), z.unknown()).optional(),
  runtime: AgentRuntimeSchema,
});
