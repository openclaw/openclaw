import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import { boardStore } from "../gateway/board-store.js";
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

it("joins an accepted Board consumer and its dependent write before releasing the borrow", async () => {
  const { target } = await fixture("consumer-lifetime");
  const borrowed = await captureOpenClawAgentDatabaseExecution({
    kind: "ephemeral",
    agentId: actor.agentId,
    env,
    authority,
    existingOnly: true,
  });
  assert(borrowed);
  const store = new SqliteBoardStore({
    env,
    resolveSession: () => ({
      ...target,
      agentId: borrowed.agentId,
      path: borrowed.path,
      incognito: { actor: borrowed, authority },
    }),
  });
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const published = createDeferredCore();
  const stop = sessionChanges.subscribe((change) => {
    if (!("all" in change) && change.sessionKey === target.sessionKey) {
      published.resolve();
    }
  });
  const pending = store.useSnapshot(target, async () => {
    entered.resolve();
    await resume.promise;
    await store.putWidget({
      ...target,
      name: "retained",
      content: { kind: "html", html: "<p>Accepted</p>" },
    });
  });
  const rejected = expect(pending).rejects.toThrow("reference is released");
  let releasing: Promise<void> | undefined;
  try {
    await awaitGateBeforeSettlement(entered.promise, pending, "Board consumer was not reached");
    let released = false;
    releasing = borrowed.release().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    resume.resolve();
    await awaitGateBeforeSettlement(
      published.promise,
      pending,
      "Dependent Board write was abandoned",
    );
    await rejected;
    await releasing;
    expect(
      await actor.sessions.sideData(authority, {
        type: "session.boards.readSnapshot",
        input: { sessionKey: target.sessionKey },
      }),
    ).toMatchObject({ snapshot: { widgets: [{ name: "retained" }] } });
  } finally {
    resume.resolve();
    stop();
    await Promise.allSettled([pending, releasing, borrowed.release()]);
  }
});

it("composes Gateway Board writes, grants and reads from the shared actor binding with zero caller SQL", async () => {
  const { target } = await fixture("board");
  const store = boardStore;
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  const changes: SessionRowChange[] = [];
  const stop = sessionChanges.subscribe((change) => {
    changes.push(change);
  });
  const sql = observeHostDataSql();
  try {
    await withIncognitoSessionActor(actor, async () => {
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
      expect(await store.useWidgetDocument(target, "status", (document) => document)).toMatchObject(
        {
          html: "<p>private</p>",
          grantState: "granted",
        },
      );
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
    });
  } finally {
    sql.restore();
    stop();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
});

it.each(["read", "write", "prepared-write"] as const)(
  "rechecks Board caller after %s composition settles",
  async (operation) => {
    let current = true;
    const { target, store } = await fixture(`settled-${operation}`, {
      assertCurrent() {
        if (!current) {
          throw new Error("Board caller retired after settlement");
        }
      },
    });
    await store.putWidget({
      ...target,
      name: "private",
      content: { kind: "html", html: "<p>Stored private content</p>" },
    });
    const changes: SessionRowChange[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if (!("all" in change) && change.sessionKey === target.sessionKey) {
        changes.push(change);
      }
    });
    const retain = actor.sessions.withSharedState.bind(actor.sessions);
    let first = true;
    const completed = vi
      .spyOn(actor.sessions, "withSharedState")
      .mockImplementation(<T>(work: () => Promise<T>) => {
        const revoke = first;
        first = false;
        return retain(work).then((result) => {
          if (revoke) {
            current = false;
          }
          return result;
        });
      });
    try {
      let result: Promise<unknown>;
      if (operation === "read") {
        result = store.getSnapshot(target);
      } else if (operation === "write") {
        result = store.putWidget({
          ...target,
          name: "accepted",
          content: { kind: "html", html: "<p>Committed</p>" },
        });
      } else {
        result = store.putWidget(
          {
            ...target,
            name: "accepted",
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
          { resolveMcpAppInteraction: async () => true },
        );
      }
      await expect(result).rejects.toThrow("Board caller retired after settlement");
      actor.assertReadable();
      expect(changes).toHaveLength(operation === "read" ? 0 : 1);
      expect(
        await actor.sessions.sideData(authority, {
          type: "session.boards.readSnapshot",
          input: { sessionKey: target.sessionKey },
        }),
      ).toMatchObject({ snapshot: { revision: operation === "read" ? 1 : 2 } });
    } finally {
      completed.mockRestore();
      stop();
    }
  },
);

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
