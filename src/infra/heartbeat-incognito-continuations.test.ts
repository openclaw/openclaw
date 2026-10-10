import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import { appendPreparedTranscriptEvent } from "../config/sessions/session-transcript-event.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import * as ttsPreferences from "../tts/tts-preferences.js";
import { publishHeartbeatSessionReply } from "./heartbeat-session-publication.js";
import { maybeApplyTtsToMessageActionSendPayload } from "./outbound/message-action-tts.js";
import {
  bindOutboundSessionEntry,
  captureOutboundSessionBinding,
  prepareOutboundSessionBinding,
} from "./outbound/outbound-session.js";

// mock-isolation: Control the preference wait without reading the operator's TTS preference file.
vi.mock("../tts/tts-preferences.js", () => ({ prepareTtsPreferences: vi.fn(async () => ({})) }));
// mock-isolation: Exercise post-preparation authority without contacting a speech provider.
vi.mock("../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: vi.fn(async ({ payload }: { payload: object }) => ({
    ...payload,
    audioAsVoice: true,
  })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;
const authority = { assertCurrent() {} };

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("heartbeat-incognito-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
});
afterAll(async () => {
  await actor?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function scope(name: string) {
  return {
    agentId: "main",
    storePath: actor.path,
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    env,
  };
}

it("publishes and replays a bound heartbeat using the actor without host SQL", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const target = scope("publication");
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        incognito: true,
        lifecycleRevision: "generation",
      },
    });
    const sql = observeHostDataSql();
    try {
      const params = {
        ...target,
        cfg: {},
        expectedGeneration: { sessionId: target.sessionId, lifecycleRevision: "generation" },
        occurrenceIds: ["completion"],
        payload: { text: "The private task finished." },
      };
      const first = await publishHeartbeatSessionReply(params);
      expect(first).toMatchObject({ ok: true });
      expect(await publishHeartbeatSessionReply(params)).toEqual(first);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});

it("keeps an exact active-entry claim across unrelated appends and revokes it on branch selection", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const target = scope("anchor");
    await actor.sessions.create(authority, {
      sessionKey: target.sessionKey,
      entry: {
        sessionId: target.sessionId,
        updatedAt: Date.now(),
        createdAt: Date.now(),
        incognito: true,
      },
    });
    await appendTranscriptMessage(target, {
      eventId: "anchor-input",
      parentId: null,
      message: { role: "user", content: "input" },
    });
    await appendTranscriptMessage(target, {
      eventId: "anchor-answer",
      parentId: "anchor-input",
      message: { role: "assistant", content: "answer" },
    });
    const retained = await actor.sessions.retainCompletionSource(authority, {
      sessionKey: target.sessionKey,
      sessionId: target.sessionId,
      entryId: "anchor-answer",
    });
    try {
      await appendTranscriptMessage(target, {
        eventId: "anchor-later",
        parentId: "anchor-answer",
        message: { role: "user", content: "later" },
      });
      expect(() => retained.assertCurrent()).not.toThrow();
      await appendPreparedTranscriptEvent(
        target,
        {
          type: "leaf",
          id: "anchor-cut",
          parentId: "anchor-later",
          targetId: "anchor-input",
        },
        () => authority.assertCurrent(),
      );
      expect(() => retained.assertCurrent()).toThrow("no longer current");
    } finally {
      await retained.release();
    }
  });
});

it("uses the actor's TTS preference and rejects a change during preference preparation", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const target = scope("tts");
    const entry = {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      incognito: true as const,
      ttsAuto: "always" as const,
    };
    await actor.sessions.create(authority, { sessionKey: target.sessionKey, entry });
    const params = {
      payload: { text: "Speak privately" },
      cfg: { session: { store: actor.path } },
      channel: "test",
      agentId: "main",
      sessionKey: target.sessionKey,
      dryRun: false,
    };
    expect(await maybeApplyTtsToMessageActionSendPayload(params)).toMatchObject({
      audioAsVoice: true,
    });
    const entered = createDeferred();
    const release = createDeferred();
    vi.mocked(ttsPreferences.prepareTtsPreferences).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {};
    });
    const pending = maybeApplyTtsToMessageActionSendPayload(params);
    void pending.catch(() => undefined);
    try {
      await entered.promise;
      await replaceSessionEntry(target, { ...entry, ttsAuto: "off" });
      expect((await readSessionEntryReadOnlyInWorker(target))?.ttsAuto).toBe("off");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
    await expect(pending).rejects.toThrow("TTS preference changed");
  });
});

it("inherits actor source policy into a separate durable destination and fences changed policy", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const source = scope("outbound-source");
    const entry = {
      sessionId: source.sessionId,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      incognito: true as const,
      sandbox: "required" as const,
      createdVia: "spawn" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: "source-owner" },
      skillLibrarySelections: [
        {
          skillId: "00000000-0000-0000-0000-000000000001",
          revision: "a".repeat(64),
          name: "selected",
          ownerProfileId: null,
        },
      ],
    };
    await actor.sessions.create(authority, { sessionKey: source.sessionKey, entry });
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const cfg = { session: { store: actor.path } };
    const capture = () =>
      prepareOutboundSessionBinding(
        captureOutboundSessionBinding({
          cfg,
          scope: { agentId: "main", databaseAgentId: "main", storePath, env },
          sourceSessionKey: source.sessionKey,
        }),
      );
    const route = {
      sessionKey: "agent:main:test:direct:outbound",
      baseSessionKey: "agent:main:test:direct:outbound",
      peer: { kind: "direct" as const, id: "outbound" },
      chatType: "direct" as const,
      from: "test:outbound",
      to: "test:outbound",
    };
    await bindOutboundSessionEntry(
      { cfg, channel: "test", route, sourceSessionKey: source.sessionKey },
      capture(),
    );
    expect(
      await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        storePath,
        env,
        sessionKey: route.sessionKey,
      }),
    ).toMatchObject({
      sandbox: "required",
      createdVia: "spawn",
      createdActor: entry.createdActor,
      skillLibrarySelections: entry.skillLibrarySelections,
    });
    const captured = capture();
    const skillLibrarySelections = [
      { ...entry.skillLibrarySelections[0]!, revision: "b".repeat(64) },
    ];
    await replaceSessionEntry(source, { ...entry, skillLibrarySelections });
    expect((await readSessionEntryReadOnlyInWorker(source))?.skillLibrarySelections).toEqual(
      skillLibrarySelections,
    );
    await expect(
      bindOutboundSessionEntry(
        { cfg, channel: "test", route, sourceSessionKey: source.sessionKey },
        captured,
      ),
    ).rejects.toThrow("Outbound source creation policy changed");
  });
});
