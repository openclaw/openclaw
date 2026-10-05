import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import {
  captureSessionPendingInputWorkerCustody,
  runWithSessionPendingInputWorkerCustody,
} from "./session-accessor.sqlite-pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("accepted input worker custody", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-worker-custody-");
  let receipt: SessionPendingInputReceipt | undefined;

  afterEach(async () => {
    receipt?.finish("interrupted");
    await receipt?.settled?.();
    receipt = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("appends, consumes, and finishes worker custody across a state-directory alias", async () => {
    const fixtureRoot = path.resolve(fixture.sessionsDir(), "../../..");
    const aliasRoot = path.join(fixtureRoot, "state-alias");
    fs.symlinkSync(fixtureRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    const scope = {
      agentId: "alias-agent",
      env: { OPENCLAW_STATE_DIR: aliasRoot },
      sessionId: "alias-session",
      sessionKey: "agent:alias-agent:pending-inputs",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "Continue through worker custody",
      timestamp: 100,
      idempotencyKey: "worker-alias:user",
    };
    receipt = await stageSessionPendingInput(scope, {
      runId: "worker-alias",
      message,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected aliased pending input custody");
    }

    const custody = receipt.run(() => captureSessionPendingInputWorkerCustody());
    if (!custody) {
      throw new Error("Expected captured worker custody");
    }
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    expect(custody.facts.databasePath).toBe(fs.realpathSync(database.path));

    const workerScope = { ...scope, storePath: custody.facts.databasePath };
    const result = runWithSessionPendingInputWorkerCustody(
      custody.facts,
      custody.relocation,
      custody.assertCurrent,
      () => appendTranscriptMessageSync(workerScope, { message: receipt!.message }),
    );
    expect(result.value).toMatchObject({ ok: true, value: { appended: true } });
    custody.publish(result.receipt);
    receipt.finish("cancelled");
    await receipt.settled?.();
    receipt = undefined;

    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ content: message.content }) }),
    );
    expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [], total: 0 });
  });

  it("appends and finishes pending input through the native incognito owner", async () => {
    const scope = {
      agentId: "incognito-agent",
      env: { OPENCLAW_STATE_DIR: path.resolve(fixture.sessionsDir(), "../../..") },
      sessionId: "incognito-session",
      sessionKey: "agent:incognito-agent:dashboard:incognito-pending-input",
    };
    await upsertSessionEntryCore(scope, {
      incognito: true,
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "Continue in memory",
      timestamp: 100,
      idempotencyKey: "incognito-native:user",
    };
    receipt = await stageSessionPendingInput(scope, {
      runId: "incognito-native",
      message,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Expected incognito pending input custody");
    }

    expect(
      receipt.run(() => appendTranscriptMessageSync(scope, { message: receipt!.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });
    receipt.finish("cancelled");
    await receipt.settled?.();
    receipt = undefined;

    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({ message: expect.objectContaining({ content: message.content }) }),
    );
    expect(await listSessionPendingInputs(scope)).toMatchObject({ items: [], total: 0 });
  });
});
