import type { vi } from "vitest";
import * as bindingErrors from "../../infra/outbound/session-binding-errors.js";
import type {
  ConversationRef,
  SessionBindingRecord,
} from "../../infra/outbound/session-binding.types.js";

type MockFactory = Pick<typeof vi, "fn">;

export function createAcpBindingMocks(mock: MockFactory) {
  const mocks = {
    listBySession: mock.fn<(sessionKey: string) => SessionBindingRecord[]>(() => []),
    unbind: mock.fn<(input: unknown) => Promise<SessionBindingRecord[]>>(async () => []),
  };
  return {
    mocks,
    module: {
      listSessionBindingsBySessionAsync: async (sessionKey: string) =>
        mocks.listBySession(sessionKey),
      getSessionBindingService: () => mocks,
    },
  };
}

export function createDispatchBindingMocks(mock: MockFactory) {
  const resolveByConversation = mock.fn<
    (ref: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    }) => SessionBindingRecord | null
  >(() => null);
  const mocks = {
    listBySession: mock.fn<(targetSessionKey: string) => SessionBindingRecord[]>(() => []),
    resolveByConversation,
    resolveByConversationAsync: mock.fn(async (ref: Parameters<typeof resolveByConversation>[0]) =>
      resolveByConversation(ref),
    ),
    touch: mock.fn(),
  };
  return {
    mocks,
    module: {
      ...bindingErrors,
      listSessionBindingsBySessionAsync: async (targetSessionKey: string) =>
        mocks.listBySession(targetSessionKey),
      readSessionBindingSelectionCurrent: (refs: readonly ConversationRef[]) =>
        Promise.all(refs.map((ref) => mocks.resolveByConversationAsync(ref))),
      getSessionBindingService: () => ({
        bind: mock.fn(async () => {
          throw new Error("bind not mocked");
        }),
        getCapabilities: mock.fn(() => ({
          adapterAvailable: true,
          bindSupported: true,
          unbindSupported: true,
          placements: ["current", "child"] as const,
        })),
        listBySession: (targetSessionKey: string) => mocks.listBySession(targetSessionKey),
        resolveByConversation: mocks.resolveByConversation,
        resolveByConversationAsync: mocks.resolveByConversationAsync,
        touchAsync: mocks.touch,
        unbind: mock.fn(async () => []),
      }),
    },
  };
}
