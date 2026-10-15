// Diagnostic session context tests cover session context capture for diagnostics.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { readLatestTranscriptAssistantTextAsync } from "../config/sessions/session-transcript-assistant-read.js";
import { saveCronStore } from "../cron/store.js";
import * as cronJobNames from "../cron/store/job-name.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
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
    await appendTranscriptMessage({ agentId, sessionId, sessionKey }, { message });
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
    setRuntimeConfigSnapshot({});
    setDiagnosticsEnabledForProcess(true);
    vi.spyOn(diagnosticLogger, "isEnabled").mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (testState) {
      memorySessionActorOwners.closeDatabase({
        agentId: "incognito-agent",
        path: resolveIncognitoOpenClawAgentSqlitePath({
          agentId: "incognito-agent",
          env: testState.env,
        }),
      });
    }
    await testState?.cleanup();
    clearRuntimeConfigSnapshot();
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

  it("formats cron provenance without copying assistant content into stalled session logs", async () => {
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
    expect(message).not.toContain("cached mentions");
    expect(message).not.toContain("lastAssistant=");
    expect(
      (
        await readLatestTranscriptAssistantTextAsync({
          agentId: "clawblocker",
          sessionKey,
          sessionId: "run-456",
        })
      )?.text,
    ).toBe("There are 40\ncached mentions ready.");
    expect(await captureSessionLog({ sessionKey, cronNameLabel: "stopped" })).toContain(
      `stopped="${"a".repeat(136)}..."`,
    );
  });

  it("discards queued enrichment when its session is replaced", async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:cron:pending-job:run:previous" };
    await seedSessionTranscript({
      ...scope,
      sessionId: "previous",
      messages: [{ role: "assistant", content: "previous private reply" }],
    });
    const ready = createDeferred();
    const resume = createDeferred();
    vi.spyOn(cronJobNames, "prepareCronJobNameResolver").mockImplementation(async () => {
      ready.resolve();
      await resume.promise;
      return () => "previous job name";
    });
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
        (
          await readLatestTranscriptAssistantTextAsync({
            agentId: "incognito-agent",
            sessionId,
            sessionKey,
          })
        )?.text,
      ).toBe(privateReply);
      expect(await captureSessionLog({ sessionKey, activeSessionId: sessionId })).toBe("");
      expect(
        fs.existsSync(
          path.join(tempDir!, "agents", "incognito-agent", "agent", "openclaw-agent.sqlite"),
        ),
      ).toBe(false);
    },
  );

  it("omits context for malformed agent ids", async () => {
    expect(
      await captureSessionLog({
        sessionKey: "agent:../main:main",
        activeSessionId: "main-session",
      }),
    ).toBe("");
  });

  it("does not treat channel-owned cron segments as cron metadata", async () => {
    const sessionKey = "agent:oauth-agent:slack:cron:job-123:run:run-456";
    const message = await captureSessionLog({
      sessionKey,
      activeSessionId: "slack-session",
    });

    expect(message).toBe("");
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
