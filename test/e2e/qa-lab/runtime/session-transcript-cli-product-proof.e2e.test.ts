// QA Lab product proof for canonical session and transcript CLI management.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../../src/config/io.js";
import { upsertSessionEntryCore } from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../../../../src/transcripts/provider-types.js";
import { TranscriptsStore } from "../../../../src/transcripts/store.js";
import { summarizeTranscripts } from "../../../../src/transcripts/summary.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

const SESSION_KEY = "agent:main:qa:missing-transcript";
const SESSION_ID = "qa-missing-transcript";
const TRANSCRIPT_ID = "qa-cli-transcript";
const TRANSCRIPT_STARTED_AT = "2026-08-03T12:00:00.000Z";
const TRANSCRIPT_TEXT = "Action item: preserve the CLI transcript artifact.";

type SessionsJson = {
  count: number;
  sessions: Array<{ key: string; sessionId?: string }>;
};

type CleanupJson = {
  agentId: string;
  applied?: true;
  afterCount: number;
  beforeCount: number;
  dryRun: boolean;
  missing: number;
};

type TranscriptListJson = Array<{
  sessionId: string;
  selector: string;
  title?: string;
}>;

type TranscriptShowJson = {
  selector: string;
  session: TranscriptSessionDescriptor;
  summary: string | null;
};

type TranscriptPathJson = {
  exists: boolean;
  path: string;
  selector: string;
  sessionId: string;
};

let instance: OpenClawTestInstance | undefined;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await instance?.cleanup();
  instance = undefined;
});

async function cliJson<T>(...args: string[]): Promise<T> {
  const result = await instance!.cli([...args, "--json"]);
  if (result.code !== 0) {
    throw new Error(
      `${args.join(" ")} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

async function seedTranscript(stateDir: string, env: NodeJS.ProcessEnv) {
  const session: TranscriptSessionDescriptor = {
    sessionId: TRANSCRIPT_ID,
    title: "CLI transcript proof",
    source: {
      providerId: "manual-transcript",
      kind: "posthoc-transcript",
    },
    startedAt: TRANSCRIPT_STARTED_AT,
    stoppedAt: "2026-08-03T12:05:00.000Z",
  };
  const utterance: TranscriptUtterance = {
    final: true,
    speaker: { label: "Operator" },
    text: TRANSCRIPT_TEXT,
  };
  const store = new TranscriptsStore(path.join(stateDir, "transcripts"), { env });
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, utterance);
  await store.writeSummary(summarizeTranscripts({ session, utterances: [utterance] }), session);
  return session;
}

describe("session and transcript child CLI product proof", () => {
  it(
    "reads canonical SQLite state, delegates cleanup, and materializes transcript artifacts",
    { timeout: 180_000 },
    async () => {
      instance = await createOpenClawTestInstance({
        name: "qa-session-transcript-cli",
      });
      instance.state.applyEnv();
      await captureRuntimeConfigAsyncReader()();

      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey: SESSION_KEY,
        },
        {
          sessionId: SESSION_ID,
          updatedAt: Date.now() - 60_000,
        },
      );
      const transcriptSession = await seedTranscript(instance.stateDir, instance.env);
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();

      const sessionsBefore = await cliJson<SessionsJson>("sessions");
      expect(sessionsBefore.sessions).toContainEqual(
        expect.objectContaining({
          key: SESSION_KEY,
          sessionId: SESSION_ID,
        }),
      );

      await instance.startGateway();
      const expectGatewayRunning = () =>
        expect(instance!.child).toMatchObject({ exitCode: null, signalCode: null, killed: false });
      expectGatewayRunning();
      const cleanup = await cliJson<CleanupJson>(
        "sessions",
        "cleanup",
        "--enforce",
        "--fix-missing",
      );
      expectGatewayRunning();
      expect(cleanup).toMatchObject({
        agentId: "main",
        applied: true,
        dryRun: false,
        missing: 1,
      });
      expect(cleanup.afterCount).toBe(cleanup.beforeCount - 1);

      const sessionsAfter = await cliJson<SessionsJson>("sessions");
      expect(sessionsAfter.sessions.map(({ key }) => key)).not.toContain(SESSION_KEY);

      const transcriptList = await cliJson<TranscriptListJson>("transcripts", "list");
      expect(transcriptList).toContainEqual(
        expect.objectContaining({
          sessionId: TRANSCRIPT_ID,
          selector: "2026-08-03/qa-cli-transcript",
          title: "CLI transcript proof",
        }),
      );

      const transcriptShow = await cliJson<TranscriptShowJson>(
        "transcripts",
        "show",
        TRANSCRIPT_ID,
      );
      expect(transcriptShow).toMatchObject({
        selector: "2026-08-03/qa-cli-transcript",
        session: transcriptSession,
      });
      expect(transcriptShow.summary).toContain(TRANSCRIPT_TEXT);

      const transcriptPath = await cliJson<TranscriptPathJson>(
        "transcripts",
        "path",
        TRANSCRIPT_ID,
        "--transcript",
      );
      expect(transcriptPath).toMatchObject({
        exists: true,
        selector: "2026-08-03/qa-cli-transcript",
        sessionId: TRANSCRIPT_ID,
      });
      expect(transcriptPath.path).toBe(
        path.join(instance.stateDir, "transcripts", transcriptPath.selector, "transcript.jsonl"),
      );
      await expect(fs.readFile(transcriptPath.path, "utf8")).resolves.toContain(TRANSCRIPT_TEXT);
    },
  );
});
