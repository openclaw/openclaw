// Diagnostic session context tests cover session context capture for diagnostics.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  appendTranscriptMessageSync,
  readLatestTranscriptAssistantText,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import { saveCronStore } from "../cron/store.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { diagnosticLogger } from "./diagnostic-runtime.js";
import { logWithSessionDiagnosticContext } from "./diagnostic-session-context.js";

async function captureSessionLog(
  params: Omit<Parameters<typeof logWithSessionDiagnosticContext>[0], "level" | "format">,
) {
  const sink = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => {});
  sink.mockClear();
  await logWithSessionDiagnosticContext({ ...params, level: "warn", format: (fields) => fields });
  expect(sink).toHaveBeenCalledOnce();
  return sink.mock.calls[0]![0];
}

let tempDir: string | undefined;
let testState: OpenClawTestState | undefined;
let diagnosticsEnabled: boolean;

async function seedSessionTranscript(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  messages: unknown[];
  incognito?: boolean;
}) {
  const { agentId, sessionId, sessionKey, messages, incognito } = params;
  await replaceSessionEntry(
    { agentId, sessionKey },
    { sessionId, updatedAt: 1, ...(incognito ? { incognito: true } : {}) },
  );
  for (const message of messages) {
    appendTranscriptMessageSync({ agentId, sessionId, sessionKey }, { message });
  }
}

describe("diagnostic session context", () => {
  beforeAll(async () => {
    diagnosticsEnabled = areDiagnosticsEnabledForProcess();
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-diagnostic-session-",
    });
    tempDir = testState.stateDir;
  });

  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await testState?.cleanup();
    setDiagnosticsEnabledForProcess(diagnosticsEnabled);
    testState = undefined;
    tempDir = undefined;
  });

  it("logs cron provenance without an active session", async () => {
    expect(
      await captureSessionLog({
        sessionKey: "agent:clawblocker:cron:unlisted-job:run:unlisted-run",
      }),
    ).toBe("cronJobId=unlisted-job cronRunId=unlisted-run");
  });

  it("formats cron job and last assistant context for stalled session logs", async () => {
    const stateDir = tempDir!;
    await saveCronStore(path.join(stateDir, "cron", "jobs.json"), {
      version: 1,
      jobs: [
        {
          id: "job-123",
          name: `${"a".repeat(136)}😀${"b".repeat(140)}`,
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });
    const sessionKey = "agent:clawblocker:cron:job-123:run:run-456";
    await seedSessionTranscript({
      agentId: "clawblocker",
      sessionId: "run-456",
      sessionKey,
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: [{ type: "text", text: "There are 40\ncached mentions ready." }],
        },
      ],
    });

    const message = await captureSessionLog({
      sessionKey,
      activeSessionId: "run-456",
    });

    expect(message).toContain("cronJobId=job-123");
    expect(message).toContain("cronRunId=run-456");
    expect(message).toContain(`cronJob="${"a".repeat(136)}..."`);
    expect(message).toContain('lastAssistant="There are 40 cached mentions ready."');
    expect(await captureSessionLog({ sessionKey, cronNameLabel: "stopped" })).toContain(
      `stopped="${"a".repeat(136)}..."`,
    );
  });

  it.each([
    { label: "short", reply: "latest visible reply", expected: "latest visible reply" },
    {
      label: "unicode",
      reply: "a".repeat(136) + "😀" + "b".repeat(200),
      expected: "a".repeat(136) + "...",
    },
  ])(
    "reads bounded visible app-agent assistant text from SQLite ($label)",
    async ({ label, reply, expected }) => {
      const sessionKey = `agent:oauth-agent:${label}`;
      await seedSessionTranscript({
        agentId: "oauth-agent",
        sessionId: `oauth-${label}`,
        sessionKey,
        messages: [
          { role: "assistant", content: "older reply" },
          { role: "user", content: "later user" },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "internal reasoning",
                textSignature: JSON.stringify({ v: 1, id: "reasoning", phase: "commentary" }),
              },
              {
                type: "text",
                text: reply,
                textSignature: JSON.stringify({ v: 1, id: "reply", phase: "final_answer" }),
              },
            ],
          },
        ],
      });

      const message = await captureSessionLog({
        sessionKey,
        activeSessionId: `oauth-${label}`,
      });

      expect(message).toBe(`lastAssistant="${expected}"`);
    },
  );

  it("discards queued enrichment when its session is replaced", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSessionTranscript({
      ...scope,
      sessionId: "previous",
      messages: [{ role: "assistant", content: "previous private reply" }],
    });
    const ready = createDeferred();
    const resume = createDeferred();
    const read = sessionReads.withSessionDiagnosticTextInWorker;
    vi.spyOn(sessionReads, "withSessionDiagnosticTextInWorker").mockImplementation(
      async (...args) => {
        ready.resolve();
        await resume.promise;
        await read(...args);
      },
    );
    const message = captureSessionLog({ ...scope, activeSessionId: "previous" });
    try {
      await ready.promise;
      await replaceSessionEntry(scope, { sessionId: "replacement", updatedAt: 2 });
    } finally {
      resume.resolve();
      await message;
    }
    expect(await message).toBe("");
  });

  it.each(["dashboard", "subagent", "internal-session-effects"])(
    "never exposes a %s incognito assistant reply to durable diagnostics",
    async (sessionSurface) => {
      const sessionKey = `agent:incognito-agent:${sessionSurface}:incognito-private`;
      const sessionId = `incognito-${sessionSurface}`;
      const privateReply = `memory-only ${sessionSurface} reply`;
      await seedSessionTranscript({
        agentId: "incognito-agent",
        incognito: true,
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", content: privateReply }],
      });

      expect(
        readLatestTranscriptAssistantText({ agentId: "incognito-agent", sessionId, sessionKey })
          ?.text,
      ).toBe(privateReply);
      expect(await captureSessionLog({ sessionKey, activeSessionId: sessionId })).toBe("");
      expect(
        fs.existsSync(
          path.join(tempDir!, "agents", "incognito-agent", "agent", "openclaw-agent.sqlite"),
        ),
      ).toBe(false);
    },
  );

  it("requires the authoritative current session id before reading transcript text", async () => {
    const sessionKey = "agent:oauth-agent:main";
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "current-session",
      sessionKey,
      messages: [{ role: "assistant", content: "current private reply" }],
    });

    expect(await captureSessionLog({ sessionKey, activeSessionId: "rotated-session" })).toBe("");
    expect(await captureSessionLog({ sessionKey })).toBe("");
  });

  it("keeps identical session ids isolated to their owning agents", async () => {
    await seedSessionTranscript({
      agentId: "main",
      sessionId: "shared-session-id",
      sessionKey: "agent:main:main",
      messages: [{ role: "assistant", content: "main private reply" }],
    });
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "shared-session-id",
      sessionKey: "agent:oauth-agent:main",
      messages: [{ role: "assistant", content: "oauth private reply" }],
    });

    expect(
      await captureSessionLog({
        sessionKey: "agent:oauth-agent:main",
        activeSessionId: "shared-session-id",
      }),
    ).toBe('lastAssistant="oauth private reply"');
  });

  it("rejects malformed agent ids before resolving a default agent transcript", async () => {
    await seedSessionTranscript({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      messages: [{ role: "assistant", content: "main private reply" }],
    });

    expect(
      await captureSessionLog({
        sessionKey: "agent:../main:main",
        activeSessionId: "main-session",
      }),
    ).toBe("");
  });

  it("does not treat channel-owned cron segments as cron metadata", async () => {
    const sessionKey = "agent:oauth-agent:slack:cron:job-123:run:run-456";
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "slack-session",
      sessionKey,
      messages: [{ role: "assistant", content: "channel reply" }],
    });

    const message = await captureSessionLog({
      sessionKey,
      activeSessionId: "slack-session",
    });

    expect(message).toBe('lastAssistant="channel reply"');
  });

  it("does not create an agent database when its session store is missing", async () => {
    const databasePath = path.join(
      tempDir!,
      "agents",
      "missing-agent",
      "agent",
      "openclaw-agent.sqlite",
    );
    expect(fs.existsSync(databasePath)).toBe(false);

    expect(
      await captureSessionLog({
        sessionKey: "agent:missing-agent:main",
        activeSessionId: "missing",
      }),
    ).toBe("");
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
