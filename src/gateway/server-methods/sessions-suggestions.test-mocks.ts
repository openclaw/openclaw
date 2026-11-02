import { vi } from "vitest";
import type { PresenceEntry } from "../../../packages/gateway-protocol/src/schema/snapshot.js";

const mocks = vi.hoisted(() => ({
  handleChatSend: vi.fn(),
  afterSuggestionClaim: vi.fn<() => void | Promise<void>>(),
  suggestionMutationFailure: undefined as
    | "claim"
    | "release"
    | "release-unexpected"
    | "finalize"
    | undefined,
  presence: [] as Array<Pick<PresenceEntry, "user" | "watchedSessions">>,
}));

vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));
vi.mock("../../infra/system-presence.js", () => ({
  listSystemPresence: () => mocks.presence,
}));
vi.mock("../../config/sessions/session-metadata-write.async.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/sessions/session-metadata-write.async.js")>();
  const { SessionWorkStartInvalidatedError } = await import("../../config/sessions/lifecycle.js");
  const failIfRequested = (phase: "claim" | "release" | "finalize") => {
    if (mocks.suggestionMutationFailure === phase) {
      throw new SessionWorkStartInvalidatedError("session changed in test");
    }
  };
  return {
    ...actual,
    claimSessionSuggestionDispatchInWorker: async (
      ...args: Parameters<typeof actual.claimSessionSuggestionDispatchInWorker>
    ) => {
      failIfRequested("claim");
      const result = await actual.claimSessionSuggestionDispatchInWorker(...args);
      if (result?.kind === "claimed") {
        await mocks.afterSuggestionClaim();
      }
      return result;
    },
    finalizeSessionSuggestionClaimInWorker: (
      ...args: Parameters<typeof actual.finalizeSessionSuggestionClaimInWorker>
    ) => {
      failIfRequested("finalize");
      return actual.finalizeSessionSuggestionClaimInWorker(...args);
    },
    releaseSessionSuggestionDispatchInWorker: (
      ...args: Parameters<typeof actual.releaseSessionSuggestionDispatchInWorker>
    ) => {
      failIfRequested("release");
      if (mocks.suggestionMutationFailure === "release-unexpected") {
        throw new Error("release storage failed");
      }
      return actual.releaseSessionSuggestionDispatchInWorker(...args);
    },
  };
});

export function getSessionSuggestionTestMocks() {
  return mocks;
}
