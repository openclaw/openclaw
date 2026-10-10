import "../../test-utils/prepare-compiled-subprocesses.js";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { captureCronCreatorSession } from "../../gateway/server-methods/cron-input-validation.js";
import { readTalkRealtimeInitialItems } from "../../gateway/talk/session-history.js";
import {
  prepareTalkSessionTarget,
  assertTalkSessionStorageTarget,
} from "../../gateway/talk/session-target.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { readCronDeliveryTargetContexts } from "./delivery-target-context.js";
import { prepareCronSession } from "./session.js";

const authority = { assertCurrent() {} };
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
const sessionKey = "agent:main:dashboard:incognito-cron-source";
const entry = {
  sessionId: "private-source",
  lifecycleRevision: "private-generation",
  updatedAt: 10,
  sessionStartedAt: 10,
  incognito: true as const,
  thinkingLevel: "high",
  createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
  skillLibrarySelections: [
    {
      skillId: "00000000-0000-0000-0000-000000000000",
      revision: "a".repeat(64),
      name: "private-skill",
      ownerProfileId: "owner",
    },
  ],
  delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "private-peer" } }),
};

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  actor = await openIncognitoTestActor(state.env, authority);
  await actor.sessions.create(authority, { sessionKey, entry });
});
afterAll(async () => {
  await actor?.close();
  await state?.cleanup();
});

it("keeps private source preferences separate from another agent's durable Cron execution", async () => {
  const targetKey = "agent:worker:cron:durable-execution";
  replaceSessionEntrySync(
    { agentId: "worker", env: state.env, sessionKey: targetKey },
    {
      sessionId: "durable-execution",
      updatedAt: 10,
    },
  );
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeHostDataSql();
    try {
      const prepared = await prepareCronSession({
        cfg: { session: { reset: { mode: "none" } } },
        agentId: "worker",
        sessionKey: targetKey,
        sourceSessionKey: sessionKey,
        nowMs: 20,
      });
      expect(prepared.initialSessionEntry?.sessionId).toBe("durable-execution");
      expect(prepared.sessionEntry.thinkingLevel).toBe("high");
      expect(prepared.sessionEntry.incognito).toBeUndefined();
      expect(prepared.storePath).not.toBe(actor.path);
      expect(readCronDeliveryTargetContexts({}, [{ agentId: "worker", sessionKey }])).toMatchObject(
        [
          {
            ok: true,
            value: {
              usedSharedMainFallback: false,
              main: { delivery: { context: { to: "private-peer" } } },
            },
          },
        ],
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
  expect(existsSync(actor.path)).toBe(false);
});

it("captures creator and Talk authority from the selected actor without native discovery", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeHostDataSql();
    try {
      const target = prepareTalkSessionTarget({}, sessionKey);
      expect(target.storePath).toBe(actor.path);
      assertTalkSessionStorageTarget({}, target);
      const creator = captureCronCreatorSession(
        {
          name: "private schedule",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "check" },
          agentId: "main",
          sessionKey,
        },
        { kind: "agentTool", agentId: "main", sessionKey, accountId: "default" },
        null,
      );
      expect(creator).toMatchObject({
        sourceConversation: { sessionKey, sessionId: entry.sessionId },
        createdActor: entry.createdActor,
        skillLibrarySelections: entry.skillLibrarySelections,
      });
      creator.assertCurrent();
      await replaceSessionEntry(
        { agentId: "main", storePath: actor.path, sessionKey },
        {
          ...entry,
          createdActor: { type: "human", source: "profile", id: "new-owner" },
        },
      );
      expect(() => creator.assertCurrent()).toThrow("Creator session changed");
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});

it("never falls back to main delivery or creates an actor for a selected missing source", async () => {
  replaceSessionEntrySync(
    { agentId: "main", env: state.env, sessionKey: "agent:main:main" },
    {
      sessionId: "main",
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "unrelated-peer" },
      }),
    },
  );
  const missingKey = "agent:missing:dashboard:incognito-absent";
  await withIncognitoSessionActor(actor, async () => {
    expect(
      readCronDeliveryTargetContexts({}, [
        { agentId: "main", sessionKey: "agent:main:dashboard:incognito-missing" },
      ]),
    ).toMatchObject([{ ok: true, value: { main: undefined, usedSharedMainFallback: false } }]);
  });
  await withIncognitoSessionBinding(
    { kind: "absent", agentId: "missing", env: state.env, authority },
    async () => {
      expect(
        readCronDeliveryTargetContexts({}, [{ agentId: "missing", sessionKey: missingKey }]),
      ).toMatchObject([{ ok: true, value: { main: undefined, usedSharedMainFallback: false } }]);
      await expect(
        prepareCronSession({ cfg: {}, agentId: "missing", sessionKey: missingKey, nowMs: 20 }),
      ).rejects.toBeInstanceOf(IncognitoSessionMissingError);
    },
  );
});

it("commits a private background result exactly once through the actor transcript", async () => {
  const target = await withIncognitoSessionActor(actor, async () => {
    const sql = observeHostDataSql();
    try {
      const params = {
        agentId: "worker",
        sessionKey,
        expectedGeneration: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        },
        text: "scheduled private result",
        idempotencyKey: "private-cron-result",
        provenance: { kind: "cron" as const, jobId: "private-job", runId: "private-run" },
        config: {},
      };
      const first = await commitBackgroundResultToSession(params);
      const repeated = await commitBackgroundResultToSession(params);
      expect(first.ok).toBe(true);
      expect(repeated).toEqual(first);
      expect(sql.queries).toEqual([]);
      return prepareTalkSessionTarget({}, sessionKey);
    } finally {
      sql.restore();
    }
  });
  const sql = observeHostDataSql();
  try {
    assertTalkSessionStorageTarget({}, target);
    expect(await readTalkRealtimeInitialItems(target, () => {})).toMatchObject([
      { role: "assistant", text: "scheduled private result" },
    ]);
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("retains the original Talk actor when its physical path receives a successor", async () => {
  const cfg = { agents: { list: [{ id: "talk-source" }] } };
  const key = "agent:talk-source:dashboard:incognito-call";
  const original = await openIncognitoTestActor(state.env, authority, "talk-source");
  const target = await withIncognitoSessionActor(original, async () =>
    prepareTalkSessionTarget(cfg, key),
  );
  await original.close();
  const successor = await openIncognitoTestActor(state.env, authority, "talk-source");
  try {
    await withIncognitoSessionActor(successor, async () => {
      expect(() => assertTalkSessionStorageTarget(cfg, target)).toThrow(/Incognito session ended/);
    });
  } finally {
    await successor.close();
  }
});
