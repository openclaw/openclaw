import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  extractDeliveryInfo,
  extractDeliveryInfoBatch,
  readExactSessionDeliveryContext,
} from "./delivery-info.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "./session-incognito-binding.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
const sessionKey = "agent:main:dashboard:incognito-delivery";
const route = { channel: "telegram", to: "123456", accountId: "default" };
let env: NodeJS.ProcessEnv;
let actor: IncognitoAgentDatabaseExecution;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: dirs.make("incognito-delivery-") };
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env,
    authority,
  });
  assert(opened);
  actor = opened;
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "actor-delivery",
      updatedAt: 1,
      incognito: true,
      delivery: normalizeSessionDeliveryState({ context: route }),
    },
  });
});
afterAll(async () => actor?.close());

it("routes explicit actor delivery from acknowledged facts without host SQL", async () => {
  await withIncognitoSessionActor(actor, async () => {
    const sql = observeMainThreadSql();
    try {
      expect(extractDeliveryInfoBatch([sessionKey, sessionKey], { cfg: {} })).toEqual([
        { deliveryContext: route, threadId: undefined },
        { deliveryContext: route, threadId: undefined },
      ]);
      expect(readExactSessionDeliveryContext({ cfg: {}, sessionKey })).toEqual(route);
      expect(
        readExactSessionDeliveryContext({ cfg: {}, sessionKey, sessionId: "superseded" }),
      ).toBeUndefined();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});

it("keeps selected absence separate from an unbound native route", async () => {
  const agentId = "native-delivery";
  const key = `agent:${agentId}:dashboard:incognito-route`;
  const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
  await withEnvAsync(env, async () => {
    try {
      await replaceSessionEntry(
        { agentId, sessionKey: key, env },
        {
          sessionId: "native-delivery",
          updatedAt: 1,
          incognito: true,
          delivery: normalizeSessionDeliveryState({ context: route }),
        },
      );
      expect(extractDeliveryInfo(key, { cfg: {} }).deliveryContext).toEqual(route);
      await withIncognitoSessionBinding({ kind: "absent", agentId, env, authority }, async () => {
        const sql = observeMainThreadSql();
        try {
          expect(extractDeliveryInfo(key, { cfg: {} }).deliveryContext).toBeUndefined();
          expect(readExactSessionDeliveryContext({ cfg: {}, sessionKey: key })).toBeUndefined();
          sql.expectIdle();
        } finally {
          sql.restore();
        }
      });
      expect(extractDeliveryInfo(key, { cfg: {} }).deliveryContext).toEqual(route);
      expect(
        captureOpenClawAgentDatabaseExecution
          .listIncognito(env)
          .some((entry) => entry.agentId === agentId),
      ).toBe(false);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(path, agentId);
    }
  });
});

it("does not hide loss of a retained actor as missing delivery", async () => {
  const opened = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "ended-delivery",
    env,
    authority,
  });
  assert(opened);
  await opened.close();
  expect(() =>
    withIncognitoSessionBinding({ actor: opened }, () =>
      extractDeliveryInfo("agent:ended-delivery:dashboard:incognito-route", { cfg: {} }),
    ),
  ).toThrow(/Incognito session ended/);
});
