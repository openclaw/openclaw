import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.test-support.js";

const receipts: SessionPendingInputReceipt[] = [];
afterEach(async () => {
  for (const receipt of receipts.splice(0)) {
    receipt.finish("interrupted");
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
});

function fixture(stateDir: string, alias = false) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourceAgent = alias ? "main" : "ops";
  const sourcePath = path.join(stateDir, `${sourceAgent}.sqlite`);
  const destinationPath = path.join(stateDir, "main.sqlite");
  const sourceKey = alias
    ? "agent:main:matrix:channel:!parent:example.org"
    : "agent:main:private-parent";
  const canonicalKey = alias ? "agent:main:matrix:channel:!Parent:example.org" : sourceKey;
  const sessionId = "private-parent-generation";
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    session: {
      store: path.join(stateDir, "{agentId}.sqlite"),
      ...(alias ? { mainKey: "work" } : {}),
    },
  };
  const database = (destination = false) =>
    openOpenClawAgentDatabase({
      agentId: destination ? "main" : sourceAgent,
      env,
      path: destination ? destinationPath : sourcePath,
    });
  const scope = (destination = false) => ({
    agentId: "main",
    env,
    sessionKey: destination ? canonicalKey : sourceKey,
    sessionId,
    storePath: destination ? destinationPath : sourcePath,
  });
  const create = (destination = false, updatedAt = 20) => {
    database(destination);
    replaceSessionEntrySync(scope(destination), { sessionId, updatedAt });
  };
  const stage = async (
    destination = false,
    content = "private child result",
    sessionKey = scope(destination).sessionKey,
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(
        { ...scope(destination), sessionKey },
        {
          runId: "announce:private-result",
          trackCompletion: true,
          assertCurrent: () => {},
          message: {
            role: "user",
            content,
            timestamp: 1,
            idempotencyKey: "announce:private-result:user",
            display: false,
            provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          },
        },
      ),
      "Expected private input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const rows = (destination = false) =>
    database(destination).db.prepare("SELECT * FROM session_input_completions").all();
  const repair = () => repairCanonicalSessionKeys({ apply: true, cfg, env });
  const close = async () => {
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest();
  };
  const restart = async () => {
    rotateAgentEventLifecycleGeneration();
    await close();
  };
  return { database, scope, create, stage, rows, canonicalKey, repair, close, restart };
}

const completed = buildAgentRunTerminalOutcome({ status: "ok" });
const stopped = buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" });

describe("Doctor canonical completion receipt repair", () => {
  it("preserves operator Stop semantics across owner repair and restart", async () => {
    await withStateDirEnv("doctor-private-completion-", async ({ stateDir }) => {
      const f = fixture(stateDir);
      f.create();
      const first = await f.stage();
      await first.completeAsync!(stopped);
      first.finish("interrupted");
      const before = f.rows();
      f.database(true).db.exec("DROP TABLE session_input_completions");
      await f.restart();
      expect(await f.repair()).toMatchObject({ repairedGroups: 1 });
      expect(f.rows(true)).toEqual(before);
      expect(f.rows()).toEqual([]);
      await f.close();
      const retry = await f.stage(true);
      expect(retry.completion).toEqual(stopped);
      expect(() => retry.run(() => "replayed work")).toThrow("already completed");
      expect(await f.repair()).toMatchObject({ repairedGroups: 0 });
      retry.finish("interrupted");
      const deleted = await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: f.scope(true).storePath,
        target: { canonicalKey: f.canonicalKey, storeKeys: [f.canonicalKey] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      expect(deleted.deleted).toBe(true);
      expect(f.rows(true)).toEqual([]);
    });
  });

  it("rekeys a final receipt before removing a same-store alias", async () => {
    await withStateDirEnv("doctor-private-alias-", async ({ stateDir }) => {
      const f = fixture(stateDir, true);
      f.create();
      await (
        await f.stage()
      ).completeAsync!(stopped);
      const before = f.rows();
      f.database()
        .db.prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.delivery', json(?)) WHERE session_key = ?",
        )
        .run(
          JSON.stringify(
            normalizeSessionDeliveryState({
              context: { channel: "matrix", to: "!Parent:example.org" },
            }),
          ),
          f.scope().sessionKey,
        );
      await f.restart();
      await f.repair();
      for (const row of before) {
        row.session_key = f.canonicalKey;
      }
      expect(f.rows(true)).toEqual(before);
      expect((await f.stage(true)).completion).toEqual(stopped);
    });
  });

  it("rolls back conflicting receipt identities without deleting either store's evidence", async () => {
    await withStateDirEnv("doctor-private-conflict-", async ({ stateDir }) => {
      const f = fixture(stateDir);
      f.create(false, 20);
      f.create(true, 10);
      await (
        await f.stage()
      ).completeAsync!(completed);
      await (
        await f.stage(true, "different private result")
      ).completeAsync!(stopped);
      const source = f.rows();
      const destination = f.rows(true);
      await f.restart();
      await expect(f.repair()).rejects.toThrow("conflicting input completions");
      expect(f.rows()).toEqual(source);
      expect(f.rows(true)).toEqual(destination);
    });
  });

  it("rejects a receipt collision owned by another logical key", async () => {
    await withStateDirEnv("doctor-private-key-conflict-", async ({ stateDir }) => {
      const f = fixture(stateDir);
      f.create();
      await (
        await f.stage()
      ).completeAsync!(completed);
      const otherKey = "agent:main:another-parent";
      replaceSessionEntrySync(
        { ...f.scope(true), sessionKey: otherKey },
        { sessionId: f.scope(true).sessionId, updatedAt: 10 },
      );
      await (
        await f.stage(true, "private child result", otherKey)
      ).completeAsync!(stopped);
      const source = f.rows();
      const destination = f.rows(true);
      await f.restart();
      await expect(f.repair()).rejects.toThrow("conflicting input completions");
      expect(f.rows()).toEqual(source);
      expect(f.rows(true)).toEqual(destination);
    });
  });
});
