import { z } from "zod";

const PolicyTokenSchema = z.string().trim().min(1);

export const ToolPolicySchema = z
  .object({
    dangerous: z.array(PolicyTokenSchema).optional(),
    allow: z.array(PolicyTokenSchema).optional(),
    deny: z.array(PolicyTokenSchema).optional(),
    requireApproval: z.array(PolicyTokenSchema).optional(),
  })
  .strict();

export const SkillInstallAllowRuleSchema = z
  .object({
    skillId: PolicyTokenSchema,
    version: PolicyTokenSchema.optional(),
    source: PolicyTokenSchema.optional(),
    installId: PolicyTokenSchema.optional(),
    kind: PolicyTokenSchema.optional(),
  })
  .strict();

export const SkillInstallPolicySchema = z
  .object({
    allow: z.array(SkillInstallAllowRuleSchema).optional(),
  })
  .strict();

export const ConfigMutationAllowRuleSchema = z
  .object({
    action: PolicyTokenSchema,
    pathPrefixes: z.array(PolicyTokenSchema).optional(),
    requireApproval: z.boolean().optional(),
    allowPolicyDisable: z.boolean().optional(),
  })
  .strict();

export const ConfigMutationPolicySchema = z
  .object({
    allow: z.array(ConfigMutationAllowRuleSchema).optional(),
  })
  .strict();

export const SignedPolicySchema = z
  .object({
    version: z.literal(1),
    keyId: PolicyTokenSchema.optional(),
    policySerial: z.number().int().nonnegative().optional(),
    issuedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    tools: ToolPolicySchema.optional(),
    skillInstalls: SkillInstallPolicySchema.optional(),
    configMutations: ConfigMutationPolicySchema.optional(),
  })
  .strict();

export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type SkillInstallAllowRule = z.infer<typeof SkillInstallAllowRuleSchema>;
export type SkillInstallPolicy = z.infer<typeof SkillInstallPolicySchema>;
export type ConfigMutationAllowRule = z.infer<typeof ConfigMutationAllowRuleSchema>;
export type ConfigMutationPolicy = z.infer<typeof ConfigMutationPolicySchema>;
export type SignedPolicy = z.infer<typeof SignedPolicySchema>;
