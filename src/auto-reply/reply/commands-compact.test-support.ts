import assert from "node:assert/strict";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const prepareEntry = vi.hoisted(
  () =>
    async ({ expected }: { expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> }) => ({
      entry: { updatedAt: 1, ...expected },
      assertCurrent() {},
      release() {},
    }),
);

// mock-isolation: Keep controller ownership real; isolate provider/storage effects and control the grace clock.
vi.mock("./commands-compact.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commands-compact.runtime.js")>();
  return {
    ...actual,
    compactEmbeddedAgentSession: vi.fn(),
    enqueueSystemEvent: vi.fn(),
    formatContextUsageShort: vi.fn(() => "Context 12.1k"),
    formatTokenCount: vi.fn((value: number) => `${value}`),
    incrementCompactionCount: vi.fn(),
    prepareCurrentSessionEntry: vi.fn(prepareEntry),
    resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
    waitForSessionControllerSettlement: vi.fn(actual.waitForSessionControllerSettlement),
  };
});

export const {
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  formatContextUsageShort,
  incrementCompactionCount,
  prepareCurrentSessionEntry,
  waitForSessionControllerSettlement,
} = await import("./commands-compact.runtime.js");
export const { handleCompactCommand } = await import("./commands-compact.js");

export function buildCompactParams(body: string, cfg: OpenClawConfig): HandleCommandsParams {
  return {
    cfg,
    ctx: { CommandSource: "text", commandText: body },
    command: {
      commandBodyNormalized: body,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    sessionKey: "agent:main:main",
    storePath: "/tmp/compact-command-test/sessions.json",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
  } as unknown as HandleCommandsParams;
}

export function resetCompactCommandMocks() {
  vi.clearAllMocks();
  vi.mocked(waitForSessionControllerSettlement).mockReset();
  vi.mocked(waitForSessionControllerSettlement).mockImplementation(async (settled) => {
    await settled;
    return true;
  });
  vi.mocked(incrementCompactionCount).mockResolvedValue(1);
  vi.mocked(prepareCurrentSessionEntry).mockImplementation(prepareEntry);
  resolveAgentDirMock.mockImplementation(
    (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
  );
  resolveSessionAgentIdMock.mockImplementation(({ sessionKey, agentId }) =>
    resolveAgentIdFromSessionKey(sessionKey, agentId ?? "main"),
  );
}

export function startCompactActiveRun(
  params: HandleCommandsParams,
  options: { abortable?: boolean; settleOnCancel?: boolean; onCancel?: () => void } = {},
) {
  const { sessionKey, storePath, agentId } = params;
  const sessionId = params.sessionEntry?.sessionId;
  assert(sessionId && storePath, "Active compaction fixture requires session and store identities");
  const target = captureSessionTarget({
    storeScope: storePath,
    sessionKey,
    agentId,
    incarnation: sessionId,
  });
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false, target });
  const cancel = vi.fn(() => {
    options.onCancel?.();
    if (options.settleOnCancel !== false) {
      operation.complete();
    }
  });
  operation.attachBackend({
    kind: "embedded",
    cancel,
    isAbortable: () => options.abortable !== false,
  });
  operation.setPhase("running");
  return { operation, cancel, target };
}

function requireFirstArg<Args extends unknown[]>(mock: { mock: { calls: Args[] } }) {
  return (index = 0): Args[0] => {
    const call = mock.mock.calls[index];
    assert(call?.[0], `Mock call ${index} missing`);
    return call[0];
  };
}

export const requireCompactEmbeddedAgentSessionCall = requireFirstArg(
  vi.mocked(compactEmbeddedAgentSession),
);
export const requireIncrementCompactionCountCall = requireFirstArg(
  vi.mocked(incrementCompactionCount),
);
export const requireResolveSessionAgentIdCall = requireFirstArg(resolveSessionAgentIdMock);

export function requireResolveAgentDirCall(index = 0) {
  const call = resolveAgentDirMock.mock.calls[index] as [OpenClawConfig, string] | undefined;
  assert(call, `resolveAgentDir call ${index} missing`);
  return call;
}
