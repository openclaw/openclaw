import type { z } from "zod";
// Defines shared agent configuration types across runtime schemas.
import type { AgentRuntimePolicySchema } from "./zod-schema.agent-entry-base.js";
import type { AgentModelSchema, AgentToolModelSchema } from "./zod-schema.agent-model.js";
import type { AgentSandboxSchema } from "./zod-schema.agent-runtime.js";

/** Agent model selector: a single provider/model ref or primary+fallback chain. */
export type AgentModelConfig = z.input<typeof AgentModelSchema>;

/** Tool-specific model selector with an optional capability timeout override. */
export type AgentToolModelConfig = z.input<typeof AgentToolModelSchema>;

/** Runtime selection policy attached to providers, models, and agent defaults. */
export type AgentRuntimePolicyConfig = NonNullable<z.input<typeof AgentRuntimePolicySchema>>;

/** Per-agent sandbox policy shared by embedded agents and sandbox backends. */
export type AgentSandboxConfig = NonNullable<z.output<typeof AgentSandboxSchema>>;
