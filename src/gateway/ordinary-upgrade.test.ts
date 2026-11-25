import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { createDefaultDeps } from "../cli/deps.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionQueuedInputPage,
} from "../config/sessions/session-pending-input-history.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import fixture from "./ordinary-upgrade.fixture.json" with { type: "json" };
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { buildGatewayCronService } from "./server-cron.js";
import { disposeSessionReadContexts } from "./session-read-contexts.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "./test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

installGatewayTestHooks();

// These are compressed, unmodified SQLite files written by pinned main production owners.
// Regeneration: ordinary-upgrade.generate.mjs. This is not a candidate-written old-shape fixture.
it("admits main-written ordinary recovery, queued input, and cron state after upgrade", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "ordinary-upgrade" }, async (state) => {
    for (const [relative, bytes] of Object.entries(fixture.files)) {
      const destination = state.statePath(relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, gunzipSync(Buffer.from(bytes, "base64")));
    }
    const databaseOptions = { agentId: "main", env: state.env };
    await withAgentDatabaseMaintenanceLease(databaseOptions, (maintenance) =>
      migrateOpenClawAgentDatabaseForMaintenance(
        {
          ...databaseOptions,
          pathname: state.statePath("agents/main/agent/openclaw-agent.sqlite"),
        },
        maintenance,
      ),
    );
    const cfg: OpenClawConfig = fixture.cfg;
    setRuntimeConfigSnapshot(cfg);
    const catalog = await prepareUserProfileCatalog();
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      workerSessionPlacementService: createWorkerSessionPlacementStore(),
    });
    context.resolveGatewayContext = () => context;
    const target = {
      ...fixture.scope,
      storePath: state.statePath("agents/main/agent/openclaw-agent.sqlite"),
    };
    const scheduler = createTestGatewayScheduler();
    const service = buildGatewayCronService({
      scheduler,
      cfg,
      deps: createDefaultDeps(),
      storePath: fixture.cronStorePath,
      broadcast: () => {},
      resolveGatewayContext: () => context,
    });
    context.cron = service.cron;
    const expectOrdinaryOwner = (authority: AdmittedRunOperatorAuthority | undefined) => {
      expect(authority).toBeDefined();
      authority!.signal?.throwIfAborted();
      expect(authority!.profileId).toBe(fixture.profileId);
      expect(authority!.scopes).toEqual(["operator.admin"]);
      expect(authority!.participationCeiling).toBeUndefined();
    };
    try {
      expect(fixture.commit).toBe("a10e445719a65729e73abd835c774c716aba752d");
      const rows = (await readSessionQueuedInputPage(target)).rows;
      expect(rows).toEqual(fixture.queued);
      const source = decodeGatewayOperatorRecoverySource(fixture.job.operatorSource.source);
      expect(source.snapshot.version).toBeUndefined();
      const restored = await restoreGatewayOperatorSource({
        snapshot: source.snapshot,
        agentId: "main",
        context,
        assertCurrent: () => signal.throwIfAborted(),
      });
      try {
        expectOrdinaryOwner(restored.authority);
      } finally {
        restored.release();
      }

      const committed = createDeferred();
      dispatchInboundMessageMock.mockImplementation(async (input) => {
        expectOrdinaryOwner(input.replyOptions?.operatorAuthority);
        expect(input.ctx.RawBody ?? input.ctx.Body).toContain("MAIN_WRITTEN_QUEUED_INPUT");
        await input.replyOptions!.userTurnTranscriptRecorder!.persistApproved();
        committed.resolve();
        return {};
      });
      await continueSessionQueuedInputs(context, target, {
        signal,
        assertCurrent: () => signal.throwIfAborted(),
      });
      expect(context.logGateway.warn).not.toHaveBeenCalled();
      await withinTest(committed.promise, signal);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect((await listSessionPendingInputs(target)).items).toEqual([]);
      expect(JSON.stringify(loadTranscriptEventsSync(target))).toContain(
        "MAIN_WRITTEN_QUEUED_INPUT",
      );
      await continueSessionQueuedInputs(context, target, {
        signal,
        assertCurrent: () => signal.throwIfAborted(),
      });
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();

      // Replace only the agent execution handoff, after real cron occurrence and operator admission.
      using execute = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation((text, options) => {
          expect(text).toContain("MAIN_WRITTEN_CRON_INPUT");
          expect(options.source).toBe("cron");
          expectOrdinaryOwner(options.scheduledAutomation?.operatorAuthority);
          options.scheduledAutomation?.assertCurrent();
          return {
            id: "ordinary-upgrade-cron-result",
            cancel: () => false,
            accepted: Promise.resolve({ ok: true }),
            settled: Promise.resolve({
              status: "completed",
              executionStarted: true,
              delivered: false,
              summary: "MAIN_WRITTEN_CRON_EXECUTED",
            }),
          };
        });
      await service.cron.start();
      const job = await service.cron.readJob(fixture.job.id);
      expect(job?.operatorSource).toEqual(fixture.job.operatorSource);
      expect(job?.payload).toEqual(fixture.job.payload);
      await expect(service.cron.run(fixture.job.id, "force")).resolves.toMatchObject({
        ok: true,
        ran: true,
      });
      expect(execute).toHaveBeenCalledOnce();
      expect((await service.cron.readJob(fixture.job.id))?.state.lastStatus).toBe("ok");
    } finally {
      await service.cron.stopAndDrain?.();
      service.cron.stop();
      await scheduler.stop();
      await disposeSessionReadContexts();
      catalog.release();
    }
  });
});
