import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

export function createAgentToolActions(params: {
  getRuntimeConfig: () => RuntimeConfigCapability;
  canUpdate: (agentId: string) => boolean;
}) {
  const stageTools = (agentId: string, values: Record<string, unknown>, ensure: boolean) => {
    if (!params.canUpdate(agentId)) {
      return;
    }
    const runtimeConfig = params.getRuntimeConfig();
    const target = runtimeConfig.agentEntry(agentId, { ensure });
    if (!target) {
      return;
    }
    for (const [field, value] of Object.entries(values)) {
      const path = [...target.path, "tools", field];
      if (value === undefined) {
        runtimeConfig.removeFormValue(path);
      } else {
        runtimeConfig.patchForm(path, value);
      }
    }
  };
  return {
    onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) =>
      stageTools(
        agentId,
        { profile: profile || undefined, ...(clearAllow ? { allow: undefined } : {}) },
        Boolean(profile || clearAllow),
      ),
    onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) =>
      stageTools(
        agentId,
        {
          alsoAllow: alsoAllow.length ? alsoAllow : undefined,
          deny: deny.length ? deny : undefined,
        },
        alsoAllow.length > 0 || deny.length > 0,
      ),
  };
}
