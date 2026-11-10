import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { expectCollected } from "../test-utils/retention.js";
import {
  createTestProjection,
  holdForeground,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

it("samples the actual resident inventory and releases diagnostics with each projection", async () => {
  const enabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  let observed:
    | Extract<DiagnosticEventPayload, { type: "sessions.projection.retention" }>
    | undefined;
  const stop = onInternalDiagnosticEvent(
    (event, metadata) => {
      if (metadata.trusted && event.type === "sessions.projection.retention") {
        observed = event;
      }
    },
    { include: ["sessions.projection.retention"] },
  );
  async function sample() {
    emitInternalDiagnosticEvent({
      type: "diagnostic.memory.sample",
      uptimeMs: 1,
      memory: {
        rssBytes: 0,
        heapTotalBytes: 0,
        heapUsedBytes: 0,
        externalBytes: 0,
        arrayBuffersBytes: 0,
      },
    });
    await waitForDiagnosticEventsDrained();
    await waitForDiagnosticEventsDrained();
    return observed;
  }
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:retention-diagnostic";
      seedRow(key, { sessionId: "retention-diagnostic", updatedAt: 1 });
      using _ = holdForeground();
      using first = await createTestProjection({ cfg, modelCatalog: [] });
      using second = await createTestProjection({ cfg, modelCatalog: [] });
      expect(await sample()).toMatchObject({ projections: 2, entries: 2 });
      expect(observed!.estimatedBytes).toBeGreaterThan(0);
      const retired = first.selectEntries().map((row) => new WeakRef(row));
      const storePath = first.selectEntries()[0]!.storeTarget.storePath;
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      await Promise.all([first.ensureMaterialized(), second.ensureMaterialized()]);
      expect(await sample()).toMatchObject({ projections: 2, entries: 0 });
      await expectCollected(...retired);
      first.dispose();
      expect(await sample()).toMatchObject({ projections: 1, entries: 0 });
      second.dispose();
      await waitForDiagnosticEventsDrained();
      expect(observed).toMatchObject({
        projections: 0,
        entries: 0,
        estimatedBytes: 0,
        truncatedProjections: 0,
      });
      observed = undefined;
      expect(await sample()).toBeUndefined();
    });
  } finally {
    stop();
    setDiagnosticsEnabledForProcess(enabled);
  }
});
