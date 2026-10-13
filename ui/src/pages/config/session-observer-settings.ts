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

export function buildSessionObserverUtilityModelPatch(selection: SessionObserverModelSelection) {
  return {
    agents: {
      defaults: {
        utilityModel:
          selection.kind === "auto" ? null : selection.kind === "disabled" ? "" : selection.model,
      },
    },
  };
}
