import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { emitTrustedAISafetyEvent } from "./diagnostic-ai-safety-events.js";
import { ensureSafetyEventStoreBridge, querySafetyEvents } from "./safety-event-store.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("safety event store", () => {
  it("retains metadata-only history across state database reopen", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-safety-events-"));
    tempDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    ensureSafetyEventStoreBridge();

    emitTrustedAISafetyEvent({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-durable",
      sourceType: "web_fetch",
      trusted: false,
    });

    expect(querySafetyEvents({ sessionId: "session-durable" }).events).toHaveLength(1);
    closeOpenClawStateDatabaseForTest();
    const afterReopen = querySafetyEvents({ sessionId: "session-durable" }).events;
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0]).toMatchObject({
      type: "ai_safety.external_content.consumed",
      sessionId: "session-durable",
      meta: { trusted: true },
    });
  });
});
