import v8 from "node:v8";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCore } from "./combined-store-gateway.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { internedDiffBaselineFileCount } from "./session-diff-baseline-intern.js";
import type { SessionEntry } from "./types.js";

// Measures what a store-wide read retains when many sessions baseline the same checkout.
// Reported numbers go in the PR, so the shape mirrors the production store that motivated
// the change: one checkout's worth of files, baselined by many sessions, read repeatedly.
const SESSIONS = 200;
const FILES = 559;
const READS = 10;

function buildBaseline(sessionId: string) {
  return {
    files: Array.from({ length: FILES }, (_, i) => ({
      // 64 hex chars, as captureSessionDiffBaseline writes them.
      fingerprint: i.toString(16).padStart(64, "0"),
      path: `packages/app/src/module-${i}/index.ts`,
    })),
    root: "/repo",
    sessionId,
    version: 1 as const,
  };
}

it("keeps one record per checkout file however many sessions baseline it", async () => {
  await withOpenClawTestState({ label: "session-diff-baseline-intern-measure" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    for (let i = 0; i < SESSIONS; i++) {
      replaceSessionEntrySync({ agentId: "main", sessionKey: `agent:main:session-${i}` }, {
        sessionDiffBaseline: buildBaseline(`session-${i}`),
        sessionId: `session-${i}`,
        updatedAt: i,
      } as unknown as SessionEntry);
    }

    const gcAvailable = typeof global.gc === "function";
    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    // Retain every read so nothing is collected before the measurement.
    const retained: Record<string, SessionEntry>[] = [];
    for (let r = 0; r < READS; r++) {
      retained.push(loadCombinedSessionStoreForGatewayCore(cfg, { projection: "full" }).store);
    }

    global.gc?.();
    const after = process.memoryUsage().heapUsed;
    const retainedMb = (after - before) / 1048576;

    // Unlike string identity, object identity is observable, so the sharing is asserted
    // directly: every reference returned has to resolve to one instance per file.
    const instances = new Set<object>();
    let references = 0;
    for (const store of retained) {
      for (const entry of Object.values(store)) {
        for (const file of entry.sessionDiffBaseline?.files ?? []) {
          references++;
          instances.add(file);
        }
      }
    }
    const snapshotPath = process.env.OPENCLAW_MEASURE_SNAPSHOT;
    if (snapshotPath) {
      v8.writeHeapSnapshot(snapshotPath);
      console.log(`heap snapshot written: ${snapshotPath}`);
    }

    // A frozen { path, fingerprint } pair costs a 3-word header, a 2-slot property array
    // and its two strings; ~200 B on 64-bit V8 for these lengths.
    const BYTES_PER_RECORD = 200;
    const theoreticalMb = (references * BYTES_PER_RECORD) / 1048576;
    const heapLine = gcAvailable
      ? `retained heap delta          : ${retainedMb.toFixed(1)} MB`
      : "retained heap delta          : not measured (run with --expose-gc)";
    console.log(
      [
        "",
        `sessions=${SESSIONS} filesPerBaseline=${FILES} reads=${READS}`,
        `baseline file references     : ${references.toLocaleString()}`,
        `distinct record instances    : ${instances.size.toLocaleString()}`,
        heapLine,
        `if every reference were a copy: ${theoreticalMb.toFixed(1)} MB`,
        "",
      ].join("\n"),
    );

    expect(references).toBe(SESSIONS * READS * FILES);
    expect(instances.size).toBe(FILES);
    expect(internedDiffBaselineFileCount()).toBe(FILES);
    if (gcAvailable) {
      expect(retainedMb).toBeLessThan(theoreticalMb);
    }
  });
});
