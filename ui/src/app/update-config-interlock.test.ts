// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
} from "../lib/config/config-test-harness.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { bindUpdateConfigWriteInterlock } from "./update-config-interlock.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

describe("update config-write interlock", () => {
  it.each(["legacy-driver-expired", "superseded", "live", "recovery-held"] as const)(
    "revalidates %s update admission before a config write",
    async (kind) => {
      const server = createConfigServerMock();
      const { runtimeConfig } = createConfigCapabilityHarness(
        server.request as GatewayBrowserClient["request"],
      );
      await runtimeConfig.ensureLoaded();
      const createdAtMs = Date.now() - 25 * 60 * 60_000;
      let run = createUpdateRunFixture({
        phase: "requested",
        createdAtMs,
        updatedAtMs: createdAtMs,
        steps: [{ step: "requested", status: "in_progress", startedAtMs: createdAtMs }],
      });
      const request = vi.fn(async (method: string) =>
        method === "update.runs.get" ? { run } : { lastRun: run },
      );
      const overlays = createApplicationOverlays(updateRunHarness(request).gateway);
      const stopInterlock = bindUpdateConfigWriteInterlock(overlays, runtimeConfig);
      const terminal = kind === "legacy-driver-expired" || kind === "superseded";
      try {
        await overlays.refreshUpdateStatus();
        expect(overlays.snapshot.updateRunning).toBe(true);
        request.mockClear();
        if (terminal) {
          run = {
            ...run,
            phase: "finished",
            status: "failed",
            reason: kind,
            updatedAtMs: Date.now(),
            finishedAtMs: Date.now(),
          };
        }
        runtimeConfig.setRaw('{"count":2}');
        expect(await runtimeConfig.save()).toBe(terminal);
        expect(request.mock.calls.filter(([method]) => method === "update.status")).toHaveLength(1);
        expect(overlays.snapshot.updateRunning).toBe(!terminal);
        expect(overlays.snapshot.updateReconciliationPending).toBe(!terminal);
        expect(overlays.snapshot.updateRun?.reason).toBe(terminal ? kind : null);
        expect(server.submissions).toHaveLength(terminal ? 1 : 0);
      } finally {
        stopInterlock();
        overlays.dispose();
        runtimeConfig.dispose();
      }
    },
  );
});
