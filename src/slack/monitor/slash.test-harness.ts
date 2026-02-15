import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
}));

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher: (...args: unknown[]) => mocks.dispatchMock(...args),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => mocks.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => mocks.upsertPairingRequestMock(...args),
}));

vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
}));

vi.mock("../../agents/identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/identity.js")>();
  return {
    ...actual,
    resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
  };
});

export function getSlackSlashMocks() {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
}
