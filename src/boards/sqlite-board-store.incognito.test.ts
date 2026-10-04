import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const authority: IncognitoSessionAuthority = { assertCurrent() {} };
let actor: IncognitoAgentDatabaseExecution;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("incognito-board-composition-") };
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

async function fixture(name: string, source = authority) {
  const target = { sessionKey: `agent:main:dashboard:incognito-${name}` };
  await actor.sessions.create(authority, {
    ...target,
    entry: { sessionId: name, lifecycleRevision: name, updatedAt: 1, incognito: true },
  });
  const store = new SqliteBoardStore({
    env,
    resolveSession: () => ({
      ...target,
      agentId: actor.agentId,
      path: actor.path,
      incognito: { actor, authority: source },
    }),
  });
  return { target, store };
}

it("composes Board writes, grants and reads on the actor with FIFO and zero caller SQL", async () => {
  const { target, store } = await fixture("board");
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribe((change) => {
    changes.push(change);
  });
  const sql = observeHostDataSql();
  try {
    const put = store.putWidget({
      ...target,
      name: "status",
      content: { kind: "html", html: "<p>private</p>" },
      declared: { tools: ["health"] },
    });
    const read = store.getSnapshot(target);
    const written = await put;
    expect(await read).toMatchObject({
      revision: 1,
      widgets: [{ name: "status", grantState: "pending" }],
    });
    const granted = await store.grant(
      target,
      "status",
      "granted",
      1,
      written.widgets[0]?.instanceId,
    );
    expect(granted).toMatchObject({ revision: 2, widgets: [{ grantState: "granted" }] });
    expect(await store.useWidgetDocument(target, "status", (document) => document)).toMatchObject({
      html: "<p>private</p>",
      grantState: "granted",
    });
    // Consumer continuation must release the reader's FIFO turn before its next write.
    expect(
      await store.useSnapshot(target, () =>
        store.applyOps(target, [{ kind: "widget_resize", name: "status", sizeW: 8, sizeH: 6 }]),
      ),
    ).toMatchObject({ revision: 3 });
    expect(changes).toEqual(
      Array.from({ length: 3 }, () => ({ sessionKey: target.sessionKey, storePath: actor.path })),
    );
    expect(sql.queries).toEqual([]);
    expect(existsSync(actor.path)).toBe(false);
  } finally {
    sql.restore();
    stop();
  }
});

it.each(["transaction", "commit"] as const)(
  "refuses revoked Board policy at %s",
  async (refusedStage) => {
    let enforce = false;
    const { target, store } = await fixture(`revoke-${refusedStage}`, {
      assertCurrent() {},
      authorize(stage) {
        if (enforce && stage === refusedStage) {
          throw new Error("Board policy revoked");
        }
      },
    });
    enforce = true;
    await expect(
      store.putWidget({ ...target, name: "denied", content: { kind: "html", html: "denied" } }),
    ).rejects.toThrow("Board policy revoked");
    enforce = false;
    expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
  },
);

it("plans interactive widgets outside the actor turn and checks authority after the wait", async () => {
  const { target, store } = await fixture("preparation");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let allowed = true;
  const pending = store.putWidget(
    {
      ...target,
      name: "app",
      content: {
        kind: "mcp-app",
        interactive: true,
        descriptor: {
          serverName: "server",
          toolName: "tool",
          uiResourceUri: "ui://app",
          toolCallId: "call",
        },
      },
    },
    {
      assertCurrent() {
        if (!allowed) {
          throw new Error("Approval source retired");
        }
      },
      async resolveMcpAppInteraction() {
        entered.resolve();
        await release.promise;
        return true;
      },
    },
  );
  void pending.catch(() => undefined);
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Board preparation was not reached");
    expect(await store.getSnapshot(target)).toMatchObject({ revision: 0 });
    allowed = false;
    release.resolve();
    await expect(pending).rejects.toThrow("Approval source retired");
    expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
});

it.each(["transaction", "commit"] as const)(
  "refuses asynchronous Board authorization after preparation at %s",
  async (refusedStage) => {
    let prepared = false;
    const { target, store } = await fixture(`async-${refusedStage}`, {
      assertCurrent() {},
      authorize(stage) {
        return prepared && stage === refusedStage ? Promise.resolve() : undefined;
      },
    });
    await expect(
      store.putWidget(
        {
          ...target,
          name: "app",
          content: {
            kind: "mcp-app",
            interactive: true,
            descriptor: {
              serverName: "server",
              toolName: "tool",
              uiResourceUri: "ui://app",
              toolCallId: "call",
            },
          },
        },
        {
          async resolveMcpAppInteraction() {
            prepared = true;
            return true;
          },
        },
      ),
    ).rejects.toThrow("grants must remain synchronous");
    prepared = false;
    expect(await store.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
  },
);
