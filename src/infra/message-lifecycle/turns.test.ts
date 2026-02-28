import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { clearLifecycleDbCacheForTest, getLifecycleDb } from "./db.js";
import { acceptTurn, finalizeTurn, pruneTurns } from "./turns.js";

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Body: "hello",
    From: "+1555",
    To: "+1999",
    SessionKey: "session-1",
    AccountId: "acct-1",
    MessageSid: "msg-001",
    Provider: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "+1999",
    ...overrides,
  } as MsgContext;
}

describe("acceptTurn persistent dedup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-turns-test-"));
  });

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first accept returns accepted: true", () => {
    const result = acceptTurn(makeCtx(), { stateDir: tmpDir });
    expect(result.accepted).toBe(true);
    expect(result.id).toBeTruthy();
  });

  it("duplicate dedupe_key returns accepted: false", () => {
    const ctx = makeCtx();
    const first = acceptTurn(ctx, { stateDir: tmpDir });
    expect(first.accepted).toBe(true);

    const second = acceptTurn(ctx, { stateDir: tmpDir });
    expect(second.accepted).toBe(false);
  });

  it("different messages are accepted independently", () => {
    const ctx1 = makeCtx({ MessageSid: "msg-001" });
    const ctx2 = makeCtx({ MessageSid: "msg-002" });

    expect(acceptTurn(ctx1, { stateDir: tmpDir }).accepted).toBe(true);
    expect(acceptTurn(ctx2, { stateDir: tmpDir }).accepted).toBe(true);
  });

  it("missing MessageSid falls through to unconditional INSERT", () => {
    const ctx = makeCtx({ MessageSid: undefined });
    const first = acceptTurn(ctx, { stateDir: tmpDir });
    expect(first.accepted).toBe(true);

    // Without a dedupe key, a second insert also succeeds (no dedup)
    const second = acceptTurn(ctx, { stateDir: tmpDir });
    expect(second.accepted).toBe(true);
  });

  it("missing Provider falls through to unconditional INSERT", () => {
    const ctx = makeCtx({
      Provider: undefined,
      OriginatingChannel: undefined,
      Surface: undefined,
    });
    const first = acceptTurn(ctx, { stateDir: tmpDir });
    expect(first.accepted).toBe(true);

    const second = acceptTurn(ctx, { stateDir: tmpDir });
    expect(second.accepted).toBe(true);
  });

  it("dedup survives across calls (simulates restart persistence)", () => {
    const ctx = makeCtx();
    expect(acceptTurn(ctx, { stateDir: tmpDir }).accepted).toBe(true);

    // Clear the DB cache to simulate a restart — DB file persists on disk
    clearLifecycleDbCacheForTest();

    expect(acceptTurn(ctx, { stateDir: tmpDir }).accepted).toBe(false);
  });

  it("pruned turn allows re-acceptance", () => {
    const ctx = makeCtx();
    const result = acceptTurn(ctx, { stateDir: tmpDir });
    expect(result.accepted).toBe(true);

    // Finalize and backdate so prune with age=0 picks it up (strict < comparison)
    finalizeTurn(result.id, "delivered", { stateDir: tmpDir });
    const db = getLifecycleDb(tmpDir);
    const past = Date.now() - 10_000;
    db.prepare(
      "UPDATE message_turns SET completed_at=?, updated_at=?, accepted_at=? WHERE id=?",
    ).run(past, past, past, result.id);
    pruneTurns(0, { stateDir: tmpDir });

    // Same dedupe key should now be accepted again
    const reaccepted = acceptTurn(ctx, { stateDir: tmpDir });
    expect(reaccepted.accepted).toBe(true);
  });
});
