import type { AgentModelConfig } from "../../../../src/config/types.agents-shared.js";
import { modelSettingPatch, withModelSettingPrimary } from "../../lib/model-setting.ts";

export type SessionObserverModelSelection =
  | { kind: "auto" }
  | { kind: "disabled" }
  | { kind: "model"; model: string };

export function buildSessionObserverTogglePatch(enabled: boolean) {
  return {
    gateway: {
      controlUi: {
        // The server default is enabled. null restores that default; false is an explicit opt-out.
        sessionObserver: enabled ? null : false,
      },
    },
  };
}

export function buildSessionObserverUtilityModelPatch(
  selection: SessionObserverModelSelection,
  current: AgentModelConfig | null = null,
) {
  return {
    agents: {
      defaults: {
        utilityModel: modelSettingPatch(
          withModelSettingPrimary(
            current,
            selection.kind === "auto" ? null : selection.kind === "disabled" ? "" : selection.model,
          ),
        ),
      },
    },
  };
}
