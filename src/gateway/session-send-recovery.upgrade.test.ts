import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readChatPendingInputs } from "./server-methods/chat-pending-inputs.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";
import { recoverSessionSendDeliveries } from "./session-send-recovery.js";

// Captured row shape from openclaw@2026.10.5 (npm latest, commit 1b58cb9a1b4f):
// src/config/sessions/session-pending-input-operations.kernel.ts:155-168,
// src/state/openclaw-agent-schema.sql:878-893, and
// src/sessions/user-turn-transcript.message.ts:215-230. That release did not
// record chatInputRecovery, so its accepted chat inputs cannot restore authority.
const stableRow = {
  input_id: "stable-queued",
  session_key: "agent:main:stable-upgrade",
  session_id: "stable-upgrade-session",
  idempotency_key: "stable-queued:user",
  run_id: "stable-queued",
  request_hash: "request:stable-request-fingerprint",
  message_json: JSON.stringify({
    role: "user",
    content: "Synthetic input accepted by the stable release",
    timestamp: 1_792_281_600_000,
    idempotencyKey: "stable-queued:user",
  }),
  lifecycle_generation: "stable-process-generation",
  state: "queued",
  accepted_at: 1_792_281_600_000,
  consumed_event_id: null,
};

it("keeps latest-stable pending rows visible without replaying missing operator authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: stableRow.session_key,
      sessionId: stableRow.session_id,
      storePath: database.path,
      env,
    };
    writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    const rows = ["queued", "interrupted", "cancelled"].map((state) =>
      Object.assign({}, stableRow, {
        input_id: `stable-${state}`,
        idempotency_key: `stable-${state}:user`,
        run_id: `stable-${state}`,
        message_json: stableRow.message_json.replaceAll("stable-queued", `stable-${state}`),
        state,
        accepted_at: Date.now(),
      }),
    );
    const insert = database.db.prepare(`
      INSERT INTO session_pending_inputs
        (input_id, session_key, session_id, idempotency_key, run_id, request_hash,
         message_json, lifecycle_generation, state, accepted_at, consumed_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(
        row.input_id,
        row.session_key,
        row.session_id,
        row.idempotency_key,
        row.run_id,
        row.request_hash,
        row.message_json,
        row.lifecycle_generation,
        row.state,
        row.accepted_at,
        row.consumed_event_id,
      );
    }
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: { store: database.path },
    };
    setRuntimeConfigSnapshot(config);
    const context = createContext([], () => config);
    const runtime = createMockGatewayRecoveryRuntime();
    context.recoveryRuntime = runtime;

    await recoverSessionSendDeliveries(context, new AbortController().signal);

    // Read raw rows before any history access: startup itself must reconcile SIGKILL.
    const stored = database.db
      .prepare("SELECT input_id, state, message_json FROM session_pending_inputs ORDER BY seq")
      .all();
    expect(stored).toEqual(
      rows.map((row) => ({
        input_id: row.input_id,
        state: row.state === "queued" ? "interrupted" : row.state,
        message_json: row.message_json,
      })),
    );
    expect(runtime.resumeChatInput).not.toHaveBeenCalled();
    expect(runtime.dispatchAgent).not.toHaveBeenCalled();
    const visible = await readChatPendingInputs(scope, { limit: 20, maxChars: 1_000 });
    expect(visible.total).toBe(3);
    expect(visible.items).toEqual([
      expect.objectContaining({
        id: "stable-queued",
        state: "interrupted",
        message: expect.objectContaining({
          content: "Synthetic input accepted by the stable release",
        }),
      }),
      expect.objectContaining({ id: "stable-interrupted", state: "interrupted" }),
      expect.objectContaining({ id: "stable-cancelled", state: "cancelled" }),
    ]);
  });
});
