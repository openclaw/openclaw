import { describe, it, expect, beforeEach } from "vitest";
// Gate receipt for the post-compaction tool path.
//
// Tool-side staging and agent-runner-side consume must resolve to the SAME
// module instance, so a delegate staged via `continue_delegate(mode:
// "post-compaction")` is not stranded on a different in-memory Map / TaskFlow
// controller than the runner reads from.
//
// On the full-revert tip, all callers route through
// LEGACY `continuation-delegate-store.ts`. This test red-flags any future
// regression that routes the tool path through NEW `continuation/delegate-
// store.ts` while runner consume stays legacy (or vice versa).
import {
  stagePostCompactionDelegate as toolStage,
  stagedPostCompactionDelegateCount as toolCount,
  consumeStagedPostCompactionDelegates as runnerConsume,
  stagedPostCompactionDelegateCount as runnerCount,
} from "./continuation-delegate-store.js";
import * as toolStoreImport from "./continuation-delegate-store.js";
import * as runnerStoreImport from "./continuation-delegate-store.js";

describe("post-compaction substrate :: tool-stage and runner-consume share store", () => {
  const sessionKey = "post-compaction-substrate-test";

  beforeEach(() => {
    runnerConsume(sessionKey);
  });

  it("tool-stage and runner-consume reference the same module instance", () => {
    expect(toolStoreImport.stagePostCompactionDelegate).toBe(
      runnerStoreImport.stagePostCompactionDelegate,
    );
    expect(toolStoreImport.consumeStagedPostCompactionDelegates).toBe(
      runnerStoreImport.consumeStagedPostCompactionDelegates,
    );
  });

  it("delegate staged via tool path is visible to runner-side count + consume", () => {
    const firstArmedAt = 1_700_000_000_000;
    expect(runnerCount(sessionKey)).toBe(0);
    toolStage(sessionKey, {
      task: "post-compaction probe",
      createdAt: firstArmedAt,
      silent: true,
      silentWake: true,
    });
    expect(toolCount(sessionKey)).toBe(1);
    expect(runnerCount(sessionKey)).toBe(1);

    const consumed = runnerConsume(sessionKey);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      task: "post-compaction probe",
      createdAt: firstArmedAt,
      firstArmedAt,
      silent: true,
      silentWake: true,
    });
    expect(runnerCount(sessionKey)).toBe(0);
  });

  it("post-compaction delegate is not stranded on an alternate substrate", () => {
    toolStage(sessionKey, {
      task: "stranding A",
      createdAt: Date.now(),
      silent: false,
      silentWake: false,
    });
    toolStage(sessionKey, {
      task: "stranding B",
      createdAt: Date.now(),
      silent: true,
      silentWake: false,
    });

    const drained = runnerConsume(sessionKey);
    expect(drained.map((d) => d.task)).toEqual(["stranding A", "stranding B"]);
  });
});
