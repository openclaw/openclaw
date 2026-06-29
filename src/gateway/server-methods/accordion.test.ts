// accordion.toggle (02-03): the additive gateway method flips boxes.state via the
// manual-override path. Seed a box in a temp per-agent DB, invoke the handler, and
// assert success/flip plus the validation + unknown-box error shapes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBoxes, upsertBox } from "../../agents/memory/turns-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { accordionHandlers } from "./accordion.js";

const SESSION_KEY = "agent:main:main";
let priorStateDir: string | undefined;

type Captured = { success: boolean; result: unknown; error: unknown };

function invoke(params: Record<string, unknown>): Captured {
  let captured: Captured | undefined;
  accordionHandlers["accordion.toggle"]({
    params,
    respond: (success, result, error) => {
      captured = { success, result, error };
    },
    context: { getRuntimeConfig: () => ({}) } as never,
    isWebchatConnect: () => false,
  } as never);
  if (!captured) {
    throw new Error("handler did not respond");
  }
  return captured;
}

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-accd-gw-"));
});
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("accordion.toggle gateway method", () => {
  function seed() {
    upsertBox({
      agentId: "main",
      box: { boxId: "box-voice", sessionKey: SESSION_KEY, label: "Voice", state: "live" },
    });
  }

  it("collapses a box and reports success", () => {
    seed();
    const res = invoke({ sessionKey: SESSION_KEY, boxId: "box-voice", state: "collapsed" });
    expect(res.success).toBe(true);
    expect(res.result).toMatchObject({ ok: true, boxId: "box-voice", state: "collapsed" });
    expect(listBoxes({ agentId: "main", sessionKey: SESSION_KEY })[0]?.state).toBe("collapsed");
  });

  it("rejects an invalid state", () => {
    seed();
    const res = invoke({ sessionKey: SESSION_KEY, boxId: "box-voice", state: "frozen" });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("errors on an unknown box", () => {
    const res = invoke({ sessionKey: SESSION_KEY, boxId: "nope", state: "collapsed" });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
