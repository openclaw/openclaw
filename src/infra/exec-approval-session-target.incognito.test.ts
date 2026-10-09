import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { IncognitoSessionEndedError } from "../state/incognito-session-error.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import {
  doesApprovalRequestSelectChannelAccount,
  resolveApprovalRequestAccountId,
} from "./approval-request-account-binding.js";
import { resolveExecApprovalSessionTarget } from "./exec-approval-session-target.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

function request(sessionKey: string): ExecApprovalRequest {
  return {
    id: sessionKey,
    request: { command: "echo synthetic", sessionKey },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function delivery(accountId: string): SessionEntry["delivery"] {
  return {
    kind: "external",
    context: { channel: "slack", accountId, to: "channel:C123" },
    origin: { provider: "slack", accountId, to: "channel:C123" },
    route: { channel: "slack", accountId, target: { to: "channel:C123", chatType: "channel" } },
  };
}

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("approval-delivery-actor-") };
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
  await closeOpenClawStateDatabaseAsync();
});

it("routes synchronous approval selectors from current actor delivery facts, including native grants", async () => {
  const sessionKey = "agent:main:dashboard:incognito-approval-delivery";
  await actor.sessions.create(authority, {
    sessionKey,
    entry: {
      sessionId: "approval-delivery",
      updatedAt: 1,
      incognito: true,
      delivery: delivery("ops"),
    },
  });
  const params = {
    cfg: { session: { store: actor.path } },
    request: request(sessionKey),
    channel: "slack",
  };
  const select = (accountId: string) =>
    doesApprovalRequestSelectChannelAccount({
      ...params,
      accountId,
      defaultAccountId: "default",
      eligibleAccountIds: ["default", "ops", "audit"],
    });
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
      expect(select("ops")).toBe(true);
      expect(select("default")).toBe(false);
      expect(resolveExecApprovalSessionTarget(params)).toMatchObject({
        channel: "slack",
        accountId: "ops",
        to: "channel:C123",
      });
      let grants = 0;
      await patchSessionEntryCore(
        { agentId: actor.agentId, env, storePath: actor.path, sessionKey },
        () => ({ delivery: delivery("audit") }),
        {
          assertCommitAllowed() {
            grants += 1;
            expect(select("ops")).toBe(true);
            expect(select("audit")).toBe(false);
            expect(resolveExecApprovalSessionTarget(params)?.accountId).toBe("ops");
          },
        },
      );
      expect(grants).toBe(2);
      expect(select("ops")).toBe(false);
      expect(select("audit")).toBe(true);
      expect(resolveExecApprovalSessionTarget(params)?.accountId).toBe("audit");
      expect(
        resolveExecApprovalSessionTarget({
          ...params,
          request: request("agent:main:dashboard:incognito-missing-delivery"),
        }),
      ).toBeNull();
    });
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("keeps ordinary unbound private approval routing on the native owner without allocating an actor", async () => {
  const nativeEnv = { OPENCLAW_STATE_DIR: tempDirs.make("approval-delivery-native-") };
  const sessionKey = "agent:main:dashboard:incognito-native-approval";
  const storePath = path.join(
    nativeEnv.OPENCLAW_STATE_DIR,
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
  await replaceSessionEntry(
    { env: nativeEnv, storePath, sessionKey },
    { sessionId: "native-approval", updatedAt: 1, incognito: true, delivery: delivery("native") },
  );
  const params = {
    cfg: { session: { store: storePath } },
    request: request(sessionKey),
    channel: "slack",
  };
  withEnv(nativeEnv, () => {
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(nativeEnv)).toEqual([]);
    expect(resolveApprovalRequestAccountId(params)).toBe("native");
    expect(resolveExecApprovalSessionTarget(params)?.accountId).toBe("native");
    expect(captureOpenClawAgentDatabaseExecution.listIncognito(nativeEnv)).toEqual([]);
  });
});

it("refuses a retained actor after replacement instead of selecting its successor's route", async () => {
  const replacementEnv = { OPENCLAW_STATE_DIR: tempDirs.make("approval-delivery-replacement-") };
  const old = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: replacementEnv,
    authority,
  });
  assert(old);
  const sessionKey = "agent:main:dashboard:incognito-replaced-approval";
  const entry: SessionEntry = {
    sessionId: "replaced-approval",
    updatedAt: 1,
    incognito: true,
    delivery: delivery("old"),
  };
  await old.sessions.create(authority, { sessionKey, entry });
  await old.close();
  const replacement = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: "main",
    env: replacementEnv,
    authority,
  });
  assert(replacement);
  try {
    await replacement.sessions.create(authority, {
      sessionKey,
      entry: { ...entry, delivery: delivery("successor") },
    });
    const params = {
      cfg: { session: { store: old.path } },
      request: request(sessionKey),
      channel: "slack",
    };
    expect(() =>
      withIncognitoSessionBinding({ actor: old }, () => resolveApprovalRequestAccountId(params)),
    ).toThrow(IncognitoSessionEndedError);
    expect(() =>
      withIncognitoSessionBinding({ actor: old }, () => resolveExecApprovalSessionTarget(params)),
    ).toThrow(IncognitoSessionEndedError);
    expect(
      withIncognitoSessionBinding({ actor: replacement }, () =>
        resolveApprovalRequestAccountId(params),
      ),
    ).toBe("successor");
  } finally {
    await replacement.close();
  }
});
