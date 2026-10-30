import { Check } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { CronModelImpactResultSchema } from "../../../packages/gateway-protocol/src/schema/cron-model-impact.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { CronModelImpactOwner } from "../../cron/model-impact.js";
import { impactConfig, impactJob, impactOwner } from "../../cron/model-impact.test-support.js";
import { saveCronStore } from "../../cron/store.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { callCron, createReadService } from "./cron-read.test-support.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
} from "./sessions-read-cache.test-support.js";

const prepared = vi.hoisted(() => ({
  owner: undefined as CronModelImpactOwner | undefined,
  reads: vi.fn(async (..._args: unknown[]): Promise<undefined> => undefined),
}));
// mock-isolation: Fixed published metadata and session read I/O, never mock assessment or visibility decisions.
vi.mock("../../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-catalog.js")>()),
  getPublishedPreparedModelCatalogOwnerSnapshot: () => prepared.owner,
}));
vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: (...args: unknown[]) => prepared.reads(...args),
}));
afterEach(async () => {
  await disposeSessionReadContexts();
  prepared.owner = undefined;
  prepared.reads.mockClear();
  clearRuntimeConfigSnapshot();
});

it("serves the shared preview with real cron visibility and no execution, discovery, or private account disclosure", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = { ...impactConfig(), ...rolePolicyConfig() };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const viewer = roleClient("none", "impact-owner");
      const foreign = roleClient("none", "impact-foreign");
      const ownKey = "agent:main:impact-own";
      const foreignKey = "agent:main:impact-foreign";
      for (const [sessionKey, profileId] of [
        [ownKey, viewer.authenticatedUserProfile!.profileId],
        [foreignKey, foreign.authenticatedUserProfile!.profileId],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profileId! },
          },
        );
      }
      const jobs = [
        impactJob("visible", { enabled: false, owner: { agentId: "main", sessionKey: ownKey } }),
        impactJob("hidden-private-name", { owner: { agentId: "main", sessionKey: foreignKey } }),
        impactJob("private-current", {
          owner: { agentId: "main", sessionKey: ownKey },
          sessionTarget: "current",
          sessionKey: foreignKey,
          inferenceBinding: undefined,
        }),
        impactJob("private-target", {
          owner: { agentId: "main", sessionKey: ownKey },
          sessionTarget: `session:${foreignKey}`,
        }),
      ];
      const storePath = state.path("cron", "jobs.sqlite");
      await saveCronStore(storePath, { version: 1, jobs });
      const run = vi.fn();
      const cron = createReadService({
        storePath,
        resolveDefaultAgentId: () => "main",
        cronEnabled: false,
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: run,
      });
      const context = createDirectChatContext({ cron, getRuntimeConfig: () => cfg });
      prepared.owner = impactOwner(cfg);
      await initializeSessionReadContext(context);
      vi.mocked(context.loadGatewayModelCatalog).mockClear();
      prepared.reads.mockClear();
      const immutable = JSON.stringify(jobs);
      const reply = await callCron(
        context,
        "cron.modelImpact",
        { model: "fixture/new" },
        { client: viewer },
      );
      expect(reply).toHaveBeenCalledTimes(1);
      const [ok, result] = reply.mock.calls[0]!;
      expect(ok).toBe(true);
      if (!Check(CronModelImpactResultSchema, result)) {
        throw new Error("Invalid model-impact wire result");
      }
      expect(result.jobs.toSorted((a, b) => a.id.localeCompare(b.id))).toMatchObject([
        { id: "private-current", status: "unknown", after: { model: null } },
        { id: "private-target", status: "unknown", after: { model: null } },
        {
          id: "visible",
          enabled: false,
          changed: true,
          after: { model: "fixture/new" },
          status: "no-known-blocker",
        },
      ]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "caller-visible-inventory",
          severity: "info",
          message: expect.stringContaining("not a Gateway-wide inventory"),
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(
        /hidden-private-name|synthetic-key|authorizationId|inferenceBinding|profileId/,
      );
      expect(JSON.stringify(jobs)).toBe(immutable);
      expect(prepared.reads.mock.calls.flat()).not.toContainEqual(
        expect.objectContaining({ sessionKey: foreignKey }),
      );
      expect(run).not.toHaveBeenCalled();
      expect(context.loadGatewayModelCatalog).not.toHaveBeenCalled();
      const invalid = await callCron(
        context,
        "cron.modelImpact",
        { model: "   " },
        { client: viewer },
      );
      expect(invalid.mock.calls[0]?.[0]).toBe(false);
      let current = true;
      prepared.owner = { ...prepared.owner, isCurrent: () => current };
      prepared.reads.mockImplementationOnce(async () => {
        current = false;
        return undefined;
      });
      const stale = await callCron(
        context,
        "cron.modelImpact",
        { model: "fixture/new" },
        { client: viewer },
      );
      expect(stale.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
      cron.stop();
      await cron.waitForIdle();
    },
  );
});
