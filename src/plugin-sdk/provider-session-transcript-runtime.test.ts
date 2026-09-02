import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activeRuns } from "../agents/code-mode-state.js";
import { CodeModeTranscriptAuthority } from "../agents/code-mode-waiting-claim.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./plugin-test-runtime.js";
import { commitProviderSessionTranscriptPrefix } from "./provider-session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function captureClaim(
  authority: CodeModeTranscriptAuthority,
  sourceToolCallId: string,
  runId = `worker-${sourceToolCallId}`,
): AgentMessage {
  activeRuns.set(runId, {
    expiresAt: Date.now() + 60_000,
    parentToolCallId: sourceToolCallId,
    replayId: `digest-${sourceToolCallId}`,
  } as never);
  authority.capture({
    outcome: "replace",
    runId,
    sourceToolCallId,
    sourceToolName: "exec",
  });
  return {
    role: "toolResult",
    toolCallId: sourceToolCallId,
    toolName: "exec",
    content: [{ type: "text", text: `source ${sourceToolCallId}` }],
    details: { status: "waiting", runId },
    isError: false,
  } as AgentMessage;
}

function ordinaryToolResult(params: {
  callId: string;
  identity: string;
  text: string;
}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: params.callId,
    toolName: "exec",
    content: [{ type: "text", text: params.text }],
    idempotencyKey: params.identity,
    isError: false,
  } as AgentMessage;
}

function transcriptMessages(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): AgentMessage[] {
  return loadTranscriptEventsSync(target).flatMap((event) =>
    event.type === "message" ? [event.message as AgentMessage] : [],
  );
}

describe("provider session transcript runtime", () => {
  afterEach(() => {
    activeRuns.clear();
    resetGlobalHookRunner();
    closeOpenClawAgentDatabasesForTest();
  });

  it("requires the private host capability and rejects closed or stale authority", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-session",
      sessionKey: "agent:main:provider-session",
      storePath: path.join(tempDirs.make("provider-prefix-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const withAuthority = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        ...target,
        codeModeTranscriptAuthority: authority,
        runId: "writer-a",
      } as never,
      pluginId: "fixture",
    });
    const withoutAuthority = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, runId: "writer-b" } as never,
      pluginId: "fixture",
    });
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: withAuthority.capabilities,
          entries: [],
        }),
      ).resolves.toMatchObject({ kind: "replayed" });
      expect(() =>
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: withoutAuthority.capabilities,
          entries: [],
        }),
      ).toThrow("requires host transcript capability");

      authority.close();
      expect(() =>
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: withAuthority.capabilities,
          entries: [],
        }),
      ).toThrow("authority is closed");
    } finally {
      withAuthority.close();
      withoutAuthority.close();
    }
  });

  it("rejects writer rotation and host closure", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-rotation",
      sessionKey: "agent:main:provider-rotation",
      storePath: path.join(tempDirs.make("provider-rotation-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-b",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 2,
    });
    expect(() =>
      commitProviderSessionTranscriptPrefix({
        hostCapabilities: host.capabilities,
        entries: [],
      }),
    ).toThrow("authority is stale");
    host.close();
    expect(() =>
      commitProviderSessionTranscriptPrefix({
        hostCapabilities: host.capabilities,
        entries: [],
      }),
    ).toThrow("host capability is no longer active");
  });

  it("strips provider-supplied claim intents before the authority commits", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-forged-intent",
      sessionKey: "agent:main:provider-forged-intent",
      storePath: path.join(tempDirs.make("provider-forged-intent-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    const before = loadSessionEntryReadOnly(target) as InternalSessionEntry;
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          expectedLifecycleRevision: "forged",
          expectedWriterRunId: "forged",
          entries: [
            {
              codeModeClaimIntent: {
                expiresAt: Date.now() + 60_000,
                lifecycleRevision: "forged",
                outcome: "replace",
                runId: "forged",
                sourceDigest: "forged",
                sourceToolCallId: "forged",
                sourceToolName: "exec",
                writerRunId: "forged",
              },
              eventId: "provider-message",
              identity: "provider-message",
              message: {
                role: "assistant",
                content: [],
                idempotencyKey: "provider-message",
              },
            },
          ],
        } as never),
      ).resolves.toMatchObject({ kind: "committed" });
      expect(
        (loadSessionEntryReadOnly(target) as InternalSessionEntry).codeModeWaitingClaims,
      ).toEqual(before.codeModeWaitingClaims);
    } finally {
      host.close();
      authority.close();
    }
  });

  it("writes nothing when the canonical before-message hook blocks", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-hook-block",
      sessionKey: "agent:main:provider-hook-block",
      storePath: path.join(tempDirs.make("provider-hook-block-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const source = captureClaim(authority, "call-a");
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "call-a-result", identity: "provider-call-a", message: source }],
        }),
      ).resolves.toEqual({ kind: "suppressed" });
      expect(transcriptMessages(target)).toEqual([]);
      expect(authority.reserve(source)).toBeDefined();
    } finally {
      host.close();
      authority.close();
    }
  });

  it("preserves a reservation through content-only replacement", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-hook-content",
      sessionKey: "agent:main:provider-hook-content",
      storePath: path.join(tempDirs.make("provider-hook-content-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const source = captureClaim(authority, "call-a");
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: ({ message }: { message: AgentMessage }) => ({
            message: {
              ...message,
              content: [{ type: "text", text: "hook replacement" }],
            },
          }),
        },
      ]),
    );
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "call-a-result", identity: "provider-call-a", message: source }],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      const messages = transcriptMessages(target);
      expect(messages).toEqual([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "exec",
          content: [{ type: "text", text: "hook replacement" }],
          idempotencyKey: "code-mode-result:call-a",
        }),
      ]);
      const afterFirst = loadSessionEntryReadOnly(target) as InternalSessionEntry;
      expect(authority.reserve(source)).toBeUndefined();

      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "call-a-result", identity: "provider-call-a", message: source }],
        }),
      ).resolves.toMatchObject({ kind: "replayed" });
      expect(transcriptMessages(target)).toEqual(messages);
      expect(
        (loadSessionEntryReadOnly(target) as InternalSessionEntry).codeModeWaitingClaims,
      ).toEqual(afterFirst.codeModeWaitingClaims);
      expect(authority.reserve(source)).toBeUndefined();
    } finally {
      host.close();
      authority.close();
    }
  });

  it("preserves distinct provider identities for ordinary results sharing a call id", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-ordinary-shared-call",
      sessionKey: "agent:main:provider-ordinary-shared-call",
      storePath: path.join(tempDirs.make("provider-ordinary-shared-call-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    const first = ordinaryToolResult({
      callId: "shared-call",
      identity: "provider-result-a",
      text: "ordinary a",
    });
    const second = ordinaryToolResult({
      callId: "shared-call",
      identity: "provider-result-b",
      text: "ordinary b",
    });
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "ordinary-a", identity: "provider-result-a", message: first }],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "ordinary-b", identity: "provider-result-b", message: second }],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      expect(transcriptMessages(target).map((message) => message.idempotencyKey)).toEqual([
        "provider-result-a",
        "provider-result-b",
      ]);
    } finally {
      host.close();
      authority.close();
    }
  });

  it("preserves provider identity when an ordinary result collides with a stored claim call id", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-ordinary-claim-collision",
      sessionKey: "agent:main:provider-ordinary-claim-collision",
      storePath: path.join(tempDirs.make("provider-ordinary-claim-collision-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const claimed = captureClaim(authority, "shared-call");
    const ordinary = ordinaryToolResult({
      callId: "shared-call",
      identity: "provider-ordinary-collision",
      text: "ordinary collision",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    try {
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "claimed-result", identity: "provider-claim", message: claimed }],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "claimed-result", identity: "provider-claim", message: claimed }],
        }),
      ).resolves.toMatchObject({ kind: "replayed" });
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [
            {
              eventId: "ordinary-collision",
              identity: "provider-ordinary-collision",
              message: ordinary,
            },
          ],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      expect(transcriptMessages(target).map((message) => message.idempotencyKey)).toEqual([
        "code-mode-result:shared-call",
        "provider-ordinary-collision",
      ]);
    } finally {
      host.close();
      authority.close();
    }
  });

  it("rejects cross-pending identity theft and retains both reservations", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-hook-identity",
      sessionKey: "agent:main:provider-hook-identity",
      storePath: path.join(tempDirs.make("provider-hook-identity-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const sourceA = captureClaim(authority, "call-a");
    const sourceB = captureClaim(authority, "call-b");
    let stealIdentity = true;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: ({ message }: { message: AgentMessage }) => ({
            message:
              stealIdentity && message.role === "toolResult"
                ? { ...message, toolCallId: "call-b" }
                : { ...message, content: [{ type: "text", text: "safe retry" }] },
          }),
        },
      ]),
    );
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...target, codeModeTranscriptAuthority: authority, runId: "writer-a" } as never,
      pluginId: "fixture",
    });
    try {
      expect(() =>
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "call-a-result", identity: "provider-call-a", message: sourceA }],
        }),
      ).toThrow("reservation identity changed");
      expect(transcriptMessages(target)).toEqual([]);
      expect(authority.reserve(sourceA)).toBeDefined();
      expect(authority.reserve(sourceB)).toBeDefined();

      stealIdentity = false;
      await expect(
        commitProviderSessionTranscriptPrefix({
          hostCapabilities: host.capabilities,
          entries: [{ eventId: "call-a-result", identity: "provider-call-a", message: sourceA }],
        }),
      ).resolves.toMatchObject({ kind: "committed" });
      expect(authority.reserve(sourceA)).toBeUndefined();
      expect(authority.reserve(sourceB)).toBeDefined();
    } finally {
      host.close();
      authority.close();
    }
  });

  it("applies the canonical display projection", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-display",
      sessionKey: "agent:main:provider-display",
      storePath: path.join(tempDirs.make("provider-display-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        ...target,
        codeModeTranscriptAuthority: authority,
        runId: "writer-a",
        trigger: "memory",
      } as never,
      pluginId: "fixture",
    });
    try {
      await commitProviderSessionTranscriptPrefix({
        hostCapabilities: host.capabilities,
        entries: [
          {
            eventId: "assistant-memory",
            identity: "assistant-memory",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "internal memory turn" }],
              idempotencyKey: "assistant-memory",
            },
          },
        ],
      });
      expect(transcriptMessages(target)).toEqual([
        expect.objectContaining({ role: "assistant", display: false }),
      ]);
    } finally {
      host.close();
      authority.close();
    }
  });

  it("applies canonical storage redaction before commit", async () => {
    const target = {
      agentId: "main",
      sessionId: "provider-redaction",
      sessionKey: "agent:main:provider-redaction",
      storePath: path.join(tempDirs.make("provider-redaction-"), "sessions.json"),
    };
    replaceSessionEntrySync(target, {
      activeWriterRunId: "writer-a",
      lifecycleRevision: "revision-a",
      sessionId: target.sessionId,
      updatedAt: 1,
    });
    const authority = new CodeModeTranscriptAuthority({
      scope: target,
      lifecycleRevision: "revision-a",
      writerRunId: "writer-a",
    });
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: {
        ...target,
        codeModeTranscriptAuthority: authority,
        config: { logging: { redactPatterns: [String.raw`secret-[a-z]+`] } },
        runId: "writer-a",
      } as never,
      pluginId: "fixture",
    });
    try {
      await commitProviderSessionTranscriptPrefix({
        hostCapabilities: host.capabilities,
        entries: [
          {
            eventId: "assistant-secret",
            identity: "assistant-secret",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "token secret-value" }],
              idempotencyKey: "assistant-secret",
            },
          },
        ],
      });
      expect(JSON.stringify(transcriptMessages(target))).not.toContain("secret-value");
    } finally {
      host.close();
      authority.close();
    }
  });
});
