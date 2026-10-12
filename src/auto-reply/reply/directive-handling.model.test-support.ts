import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

export function baseConfig(): OpenClawConfig {
  return {
    commands: { text: true },
    agents: { defaults: {} },
  } as unknown as OpenClawConfig;
}

export function createSessionEntry(
  overrides?: Partial<InternalSessionEntry>,
): InternalSessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...overrides,
  };
}
