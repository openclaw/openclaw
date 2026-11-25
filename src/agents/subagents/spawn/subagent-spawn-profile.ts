import type { SpawnSubagentContext, SpawnSubagentParams } from "./subagent-spawn-contract.js";

/** The profile can add denies, never replace the inherited ceiling or delegation floor. */
export function applySubagentProfile(input: SpawnSubagentParams, context: SpawnSubagentContext) {
  const profile = context.subagentProfile;
  const ctx = profile
    ? {
        ...context,
        inheritedToolDenylist: [...(context.inheritedToolDenylist ?? []), ...profile.deny],
        ...(context.delegatedToolDenyFloor
          ? {
              delegatedToolDenyFloor: {
                ...context.delegatedToolDenyFloor,
                deny: [...context.delegatedToolDenyFloor.deny, ...profile.deny],
              },
            }
          : {}),
      }
    : context;
  return {
    ctx,
    params: profile?.outputSchema ? { ...input, outputSchema: profile.outputSchema } : input,
    profileReceipt: profile
      ? {
          pluginId: profile.pluginId,
          id: profile.id,
          instructionsFile: profile.instructionsFile,
          instructionsSha256: profile.instructionsSha256,
        }
      : undefined,
    systemPrompt: (base: string) => (profile ? `${base}\n\n${profile.instructions}` : base),
  };
}
