// Shared compact-command mocks and fixtures for focused behavior suites.
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
    prepareCurrentSessionEntry: vi.fn(
      async ({
        expected,
      }: {
        expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
      }) => ({
        entry: { updatedAt: 1, ...expected },
        assertCurrent() {},
        release() {},
      }),
    ),
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

export function buildCompactParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBodyNormalized,
      commandText: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
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
  vi.mocked(prepareCurrentSessionEntry).mockImplementation(async ({ expected }) => ({
    entry: { updatedAt: 1, ...expected },
    assertCurrent() {},
    release() {},
  }));
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
  const sessionId = params.sessionEntry?.sessionId;
  if (!sessionId || !params.storePath) {
    throw new Error("Active compaction fixture requires session and store identities");
  }
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? "main",
    incarnation: sessionId,
  });
  const operation = createReplyOperation({
    sessionKey: params.sessionKey,
    sessionId,
    resetTriggered: false,
    target,
  });
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

export function requireCompactEmbeddedAgentSessionCall(index = 0) {
  const call = vi.mocked(compactEmbeddedAgentSession).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`compactEmbeddedAgentSession call ${index} missing`);
  }
  return call;
}

export function requireIncrementCompactionCountCall(index = 0) {
  const call = vi.mocked(incrementCompactionCount).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`incrementCompactionCount call ${index} missing`);
  }
  return call;
}

export function requireResolveSessionAgentIdCall(index = 0) {
  const call = resolveSessionAgentIdMock.mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`resolveSessionAgentId call ${index} missing`);
  }
  return call;
}

export function requireResolveAgentDirCall(index = 0) {
  const call = resolveAgentDirMock.mock.calls[index] as [OpenClawConfig, string] | undefined;
  if (!call) {
    throw new Error(`resolveAgentDir call ${index} missing`);
  }
  return call;
}
