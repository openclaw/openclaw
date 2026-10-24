import type { SessionCapability, SessionRowObservation } from "../../lib/sessions/index.ts";
import { createSessionArchiveState } from "../../lib/sessions/session-archive-state.ts";
import { createSessionRowProvenance } from "../../lib/sessions/session-row-provenance.ts";

type SessionCapabilityFixtureOverrides = Omit<Partial<SessionCapability>, "patch" | "state"> & {
  patch?: (...args: Parameters<NonNullable<SessionCapability["patch"]>>) => unknown;
  state?: Partial<SessionCapability["state"]>;
};

export function createSessionCapabilityFixture(
  overrides: SessionCapabilityFixtureOverrides = {},
): SessionCapability {
  const state = overrides.state ?? {};
  Object.defineProperties(state, {
    ...Object.getOwnPropertyDescriptors({
      result: null,
      agentId: null,
      modelOverrides: {},
      loading: false,
      error: null,
      deletedSessions: [],
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    }),
    ...Object.getOwnPropertyDescriptors(state),
  });
  const archiveState = createSessionArchiveState(
    (key) => state.result?.sessions.find((row) => row.key === key),
    () => {},
    createSessionRowProvenance(),
  );
  return {
    get presentation() {
      return { result: state.result, agentId: state.agentId };
    },
    captureConnectionScope: () => null,
    isConnectionScopeCurrent: () => false,
    subscribe: () => () => undefined,
    // Synthetic capabilities have no supplemental roster unless the test supplies one.
    observeRow: (): SessionRowObservation => ({
      row: null,
      sessionId: null,
      hasObserved: false,
      isCurrent: () => true,
      captureReconcile: () => () => ({ status: "current", row: null }),
      dispose: () => {},
    }),
    observeList: () => ({ refresh: async () => {}, dispose: () => {} }),
    deletionState: () => undefined,
    think: () => undefined,
    settingsPreview: () => undefined,
    archiveVisibility: archiveState.visibility,
    beginArchive: archiveState.beginPending,
    ...overrides,
    state,
  } as typeof overrides & SessionCapability;
}
