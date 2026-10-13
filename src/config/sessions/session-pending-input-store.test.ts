import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  createIncognitoSessionFacts,
  type IncognitoSessionActor,
} from "./session-incognito-actor.js";
import { preparePendingInputStore } from "./session-pending-input-store.js";

it.each(["closed-borrow", "rejected-retention"] as const)(
  "releases the pending input resource when owner admission fails: %s",
  async (failure) => {
    const env = {
      OPENCLAW_STATE_DIR: path.join(os.tmpdir(), `pending-input-admission-${process.pid}`),
    };
    const identity = {
      kind: "ephemeral" as const,
      handle: "pending-input-admission",
      incarnation: "pending-input-admission",
    };
    const unavailable = new Error("Pending input owner has closed");
    let closed = false;
    const assertCurrent = () => {
      if (closed && failure === "closed-borrow") {
        throw unavailable;
      }
    };
    const facts = createIncognitoSessionFacts(identity, assertCurrent, () => {});
    const actor: IncognitoSessionActor = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      identity,
      assertCurrent,
      assertReadable: assertCurrent,
      sessions: facts.bind(
        async () => {
          throw new Error("Admission must not execute a native command");
        },
        assertCurrent,
        async (operation) => {
          if (closed) {
            throw unavailable;
          }
          return operation();
        },
        assertCurrent,
      ),
    };
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    const store = await preparePendingInputStore(
      {
        agentId: "main",
        sessionId: "pending-input-admission",
        sessionKey: "agent:main:dashboard:incognito-pending-input-admission",
        env,
        incognito: { actor, authority: { assertCurrent } },
      },
      assertCurrent,
    );
    try {
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      closed = true;
      const stage = vi.fn(async () => {});
      await expect(Promise.resolve().then(() => store.withAdmission(stage, false))).rejects.toBe(
        unavailable,
      );
      expect(stage).not.toHaveBeenCalled();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      await store.release();
    }
  },
);
