import { beforeEach, vi } from "vitest";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMock = any;

const hoisted = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
}));

export function getDispatchMock(): AnyMock {
  return hoisted.dispatchMock;
}

export function getReadAllowFromStoreMock(): AnyMock {
  return hoisted.readAllowFromStoreMock;
}

export function getUpsertPairingRequestMock(): AnyMock {
  return hoisted.upsertPairingRequestMock;
}

export function getResolveAgentRouteMock(): AnyMock {
  return hoisted.resolveAgentRouteMock;
}

vi.mock("../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher: (...args: unknown[]) => hoisted.dispatchMock(...args),
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => hoisted.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => hoisted.upsertPairingRequestMock(...args),
}));

vi.mock("../../routing/resolve-route.js", () => ({
  resolveAgentRoute: (...args: unknown[]) => hoisted.resolveAgentRouteMock(...args),
}));

vi.mock("../../agents/identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/identity.js")>();
  return {
    ...actual,
    resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
  };
});

beforeEach(() => {
  hoisted.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  hoisted.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  hoisted.upsertPairingRequestMock
    .mockReset()
    .mockResolvedValue({ code: "PAIRCODE", created: true });
  hoisted.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
});
