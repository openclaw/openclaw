import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-compaction-") } };
}

describe("update run ledger compaction", () => {
  it.each([
    { name: "step count", count: 130, detail: undefined },
    { name: "diagnostic bytes", count: 30, detail: "diagnostic ".repeat(80) },
    { name: "retained phase bytes", count: 0, detail: "🦞".repeat(512) },
  ])(
    "retains candidate admission, notice custody, restoration proof, and finalization history across the $name bound and database reopen",
    ({ count, detail }) => {
      const options = isolatedOptions();
      const run = createUpdateRun({ trigger: "chat" }, options);
      const admission = {
        step: "candidate-admission",
        status: "completed" as const,
        startedAtMs: 1_000,
        endedAtMs: 2_000,
      };
      recordUpdateRunStep(run.runId, { ...admission, detail }, options);
      const notices = [
        "notice:ack",
        "notice:activating",
        "notice:verifying",
        "previous generation restoration",
        "finalize:doctor",
        "finalize:future-phase",
        // Candidate Doctor's predecessor-stop receipt: identity lives in the key.
        "finalize:predecessor-stop:1758600000000:1000:631:0123456789abcdef",
        "post-update verification",
      ];
      for (const step of [...UPDATE_RUN_PHASES, ...notices]) {
        recordUpdateRunStep(run.runId, { step, status: "completed", detail }, options);
      }
      for (let index = 0; index < count; index++) {
        recordUpdateRunStep(
          run.runId,
          { step: `diagnostic-${index}`, status: "completed", detail },
          options,
        );
      }
      closeOpenClawStateDatabaseForTest();
      const persisted = getUpdateRun(run.runId, options)!;
      expect(persisted.steps.find((step) => step.step === "candidate-admission")).toMatchObject(
        admission,
      );
      expect(persisted.steps.map((step) => step.step)).toEqual(
        expect.arrayContaining([...UPDATE_RUN_PHASES, ...notices]),
      );
      expect(persisted.steps.every((step) => step.status === "completed")).toBe(true);
      expect(persisted.steps.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    },
  );
});
