import { getAgentTestMocks } from "./agent.test-harness.js";

type SessionStoreUpdateResult = Record<string, unknown> | null | undefined;

export function dailySessionResetConfig() {
  return { session: { reset: { mode: "daily", atHour: 4 } } };
}

export function mockClonedSessionStoreUpdate() {
  const mocks = getAgentTestMocks();
  const loaded: { canonicalKey: string; entry: Record<string, unknown> } = mocks.loadSessionEntry();
  let capturedEntry: SessionStoreUpdateResult;
  mocks.updateSessionStore.mockImplementation(
    async (
      _path: string,
      updater: (
        store: Record<string, unknown>,
      ) => SessionStoreUpdateResult | Promise<SessionStoreUpdateResult>,
    ) => {
      // Rebuild per update and capture its return, not the mutable store slot.
      const store = { [loaded.canonicalKey]: structuredClone(loaded.entry) };
      const result = await updater(store);
      capturedEntry = result;
      return result;
    },
  );
  return () => capturedEntry;
}
