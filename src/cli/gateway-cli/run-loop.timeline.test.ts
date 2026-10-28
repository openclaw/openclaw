import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { flushDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import * as cleanupOwner from "./run-loop-cleanup.js";
import { runLoopFixture as fixture } from "./run-loop-mocks.test-support.js";
import { createLifecycleGate } from "./run-loop.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["drained", "retained", "failed"])(
  "closes the accounting lifetime only after late cleanup (%s)",
  async (outcome) => {
    const file = path.join(tempDirs.make("gateway-timeline-"), "timeline.jsonl");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "timeline");
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", file);
    const events = () => {
      flushDiagnosticsTimeline();
      return readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    if (outcome === "retained") {
      const create = cleanupOwner.createGatewayRunCleanup;
      vi.spyOn(cleanupOwner, "createGatewayRunCleanup").mockImplementation((...args) => {
        const owner = create(...args);
        // Retained custody without a rejection must not become a complete accounting receipt.
        vi.spyOn(owner, "drained", "get").mockReturnValue(false);
        return owner;
      });
    }
    const late = createLifecycleGate();
    fixture.hasManagedProviderLocalServices.mockReturnValue(true);
    fixture.stopManagedProviderLocalServices.mockImplementationOnce(async () => {
      await late.wait();
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        provider: "fixture",
        model: "auxiliary",
        completionId: "completion",
        attemptId: "attempt",
        usageReport: { state: "available" },
        usage: { input: 3, output: 2 },
      });
      if (outcome === "failed") throw new Error("fixture retained cleanup failure");
    });
    await fixture.withRunningGateway(async ({ captureSignal, loopPromise }) => {
      captureSignal("SIGTERM")();
      try {
        await late.entered;
        expect(events().some((event) => event.name === "timeline.capture.completed")).toBe(false);
      } finally {
        late.release();
        await expect(loopPromise).resolves.toBe(outcome === "failed" ? 1 : 0);
      }
      const rows = events();
      const usage = rows.findIndex((event) => event.name === "model.usage");
      const terminal = rows.findIndex((event) => event.name === "timeline.capture.completed");
      expect(usage).toBeGreaterThan(-1);
      expect(terminal).toBeGreaterThan(usage);
      expect(rows[terminal]).toMatchObject({ attributes: { complete: outcome === "drained" } });
    }, true);
  },
);
