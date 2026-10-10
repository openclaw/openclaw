import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../../config/sessions/session-incognito-binding.js";
import { loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { deliverPendingDeliveryNotice } from "./pending-delivery-notice.js";

const sendRecoveryNotice = vi.hoisted(() => vi.fn());
// mock-isolation: Notice delivery uses this fixture's sender, never a process-global Gateway.
vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-pending-notice-") };
  actor = await openIncognitoTestActor(env, authority);
});
afterAll(async () => actor?.close());

async function create(name: string) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = {
    sessionId: name,
    lifecycleRevision: "original",
    updatedAt: 1,
    incognito: true,
    delivery: {
      kind: "external" as const,
      route: { channel: "telegram", accountId: "default" },
      context: { channel: "telegram", to: "chat-1", accountId: "default" },
      origin: {},
    },
    pendingDeliveryNotice: {
      createdAt: 1,
      context: { channel: "telegram", to: "chat-1", accountId: "default" },
      intentId: name,
      state: "owed" as const,
    },
  };
  await actor.sessions.create(authority, { sessionKey, entry });
  return { sessionKey, entry };
}

describe("actor-owned pending delivery notices", () => {
  it("acknowledges the private notice and transcript through the actor with no host SQL", async () => {
    const { sessionKey } = await create("acknowledged");
    sendRecoveryNotice.mockResolvedValueOnce({ suppressed: false });
    const sql = observeHostDataSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        await deliverPendingDeliveryNotice(sessionKey, actor.path);
        const events = await loadTranscriptEvents({
          agentId: "main",
          sessionKey,
          sessionId: "acknowledged",
          storePath: actor.path,
        });
        expect(events.some((event) => event.type === "message")).toBe(true);
      });
      expect(
        (await actor.sessions.read(authority, { sessionKey })).entry?.pendingDeliveryNotice?.state,
      ).toBe("acknowledged");
      expect(sendRecoveryNotice).toHaveBeenLastCalledWith(
        expect.objectContaining({ liveOnly: true, isCurrent: expect.any(Function) }),
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("does not acknowledge a successor when the notice transport yields", async () => {
    const { sessionKey } = await create("replaced");
    const entered = createDeferredCore();
    const sent = createDeferredCore<{ suppressed: boolean }>();
    sendRecoveryNotice.mockImplementationOnce(() => {
      entered.resolve();
      return sent.promise;
    });
    const attempt = withIncognitoSessionActor(actor, () =>
      deliverPendingDeliveryNotice(sessionKey, actor.path),
    );
    const failure = attempt.catch((error: unknown) => error);
    try {
      await entered.promise;
      await withIncognitoSessionActor(actor, () =>
        patchSessionEntryCore({ sessionKey, storePath: actor.path }, () => ({
          lifecycleRevision: "successor",
        })),
      );
    } finally {
      sent.resolve({ suppressed: false });
      await failure;
    }
    expect(await failure).toMatchObject({ message: expect.stringContaining("generation") });
    expect(
      (await actor.sessions.read(authority, { sessionKey })).entry?.pendingDeliveryNotice?.state,
    ).toBe("owed");
  });

  it("treats selected absence as no notice without creating an actor", async () => {
    const absentEnv = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-absent-notice-") };
    const sql = observeHostDataSql();
    sendRecoveryNotice.mockClear();
    try {
      await withIncognitoSessionBinding(
        { kind: "absent", agentId: "main", env: absentEnv, authority },
        () =>
          deliverPendingDeliveryNotice(
            "agent:main:dashboard:incognito-missing",
            resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: absentEnv }),
          ),
      );
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });
});
