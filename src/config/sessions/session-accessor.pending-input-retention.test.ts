import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  bindSessionPendingInputMentionInvitation,
  bindSessionPendingInputSources,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-pending-input-retention-");
const sessionKey = "agent:main:pending-input-retention";
const sessionId = "pending-input-retention";
const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
const databaseOptions = () => toDatabaseOptions(resolveSqliteScope(scope()));
const message = (runId: string): PersistedUserTurnMessage => ({
  role: "user",
  content: "Continue the task",
  timestamp: 100,
  idempotencyKey: `${runId}:user`,
});

async function collectReleasedTargetForTest(): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await nextTurn();
    queryObjects(WeakRef);
  }
  await nextTurn();
}

beforeEach(async () => {
  setRuntimeConfigSnapshot({ session: { store: fixture.storePath() } });
  openOpenClawAgentDatabase(databaseOptions());
  await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
});

it.each([
  { collected: false, invitation: false },
  { collected: true, invitation: false },
  { collected: false, invitation: true },
  { collected: true, invitation: true },
])(
  "releases settled input authority while its timer remains pending (collected: $collected, invitation: $invitation)",
  async ({ collected, invitation }) => {
    const makeTimer = () => setTimeout(() => {}, 60_000);
    async function settle() {
      const entry = { sessionId, skillsSnapshot: { prompt: "synthetic prompt", skills: [] } };
      const reference = new WeakRef(entry);
      const receipt = (await stageSessionPendingInput(scope(), {
        runId: "retention",
        message: message("retention"),
        assertCurrent: () => {
          expect(entry.sessionId).toBe(sessionId);
        },
      }))!;
      if (invitation) {
        bindSessionPendingInputMentionInvitation(receipt, () => ({
          invitation: {
            addedBy: "sender",
            expectedEntry: { sessionId },
            profiles: [{ profileId: "guest", aliases: ["guest"], tokens: ["@guest"] }],
          },
          assertCurrent: () => {
            expect(entry.sessionId).toBe(sessionId);
          },
        }));
      }
      const execution = collected
        ? bindSessionPendingInputSources([receipt], message("collected-retention"))!
        : receipt;
      const timer = execution.run(makeTimer);
      execution.finish("cancelled");
      await execution.settled?.();
      expect(() => execution.run(() => {})).toThrow(SessionPendingInputCustodyError);
      return { reference, timer };
    }
    const { reference, timer } = await settle();
    try {
      const control = new WeakRef({});
      await collectReleasedTargetForTest();
      expect(control.deref()).toBeUndefined();
      expect(timer.hasRef()).toBe(true);
      expect(reference.deref()).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  },
);
