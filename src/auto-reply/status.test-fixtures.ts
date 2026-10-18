import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  buildStatusMessage as renderStatusMessage,
  statusModelRefs,
} from "../status/status-message.test-support.js";

type StatusArgs = Parameters<typeof renderStatusMessage>[0];
export type StatusTestArgs = Omit<Partial<StatusArgs>, "sessionEntry"> & {
  sessionEntry?: Partial<NonNullable<StatusArgs["sessionEntry"]>>;
};
export const statusContext = {
  sessionKey: "agent:main:main",
  sessionScope: "per-sender",
  queue: { mode: "collect", depth: 0 },
} as const;

export function modelArgs(
  provider: string,
  model: string,
): Pick<StatusArgs, "modelRefs" | "agent"> {
  return {
    modelRefs: statusModelRefs({ provider, model }),
    agent: { model: `${provider}/${model}` },
  };
}

export function buildStatusMessage({ sessionEntry, ...args }: StatusTestArgs): string {
  return renderStatusMessage({
    ...statusContext,
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    ...modelArgs("anthropic", "claude-opus-4-6"),
    ...args,
    sessionEntry: sessionEntry && { sessionId: "status", updatedAt: 0, ...sessionEntry },
  });
}

export function providerModels(
  ...rows: [string, string, Partial<ModelDefinitionConfig>][]
): OpenClawConfig {
  const providers: Record<string, { models: Partial<ModelDefinitionConfig>[] }> = {};
  for (const [provider, id, fields] of rows) {
    (providers[provider] ??= { models: [] }).models.push({ id, ...fields });
  }
  return { models: { providers } } as unknown as OpenClawConfig;
}
