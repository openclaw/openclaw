import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  SESSION,
  SESSION_ID,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import {
  createPrAutomationFixture,
  prAutomationSessionAccessor as accessor,
  readPrAutomationRecipeTarget,
} from "./service.pr-automation.test-support.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./isolated-agent/session.js")>(
  "./isolated-agent/session.js",
);
installRequesterCronAuthorityTestHooks();
beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});

it.each([false, true])(
  "existing archive API checks the scheduled recipe's exact identity (replaced=%s)",
  async (replaced) => {
    const fixture = await createPrAutomationFixture("autoArchive", (config) => ({
      runIsolatedAgentJob: (request) =>
        runCronIsolatedAgentTurn({
          ...request,
          cfg: config,
          deps: {},
          agentId: "main",
          sessionKey:
            resolveCronSessionTargetSessionKey(request.job.sessionTarget) ??
            `cron:${request.job.id}`,
        }),
    }));
    const respond = vi.fn();
    const releaseCore = createDeferredCore();
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const target = readPrAutomationRecipeTarget(params.prompt);
      const patch = {
        key: target.sessionKey,
        expectedSessionId: expectDefined(target.sessionId, "archive incarnation"),
        archived: true,
      };
      // Synthetic model decision; the native archive handler and its exact-ID
      // precondition are real. No GitHub lookup or merge is performed.
      await expectDefined(
        sessionMutationHandlers["sessions.patch"],
        "sessions.patch",
      )({
        req: { type: "req", id: "recipe-archive", method: "sessions.patch", params: patch },
        params: patch,
        respond,
        context: fixture.creator.context,
        client: fixture.client,
        isWebchatConnect: () => false,
      });
      if (!replaced) {
        await releaseCore.promise;
      }
      return { payloads: [{ text: "Synthetic archive request settled" }], meta: { agentMeta: {} } };
    });
    try {
      if (replaced) {
        await fixture.seed("replacement-session");
      }
      await fixture.execution.update(fixture.selected.id, { enabled: true });
      const event = await fixture.tick();
      // Successful archive disables bound jobs through the native cleanup owner,
      // cancelling this occurrence after the archive commits. A scheduler
      // cancellation is not evidence that the archive failed.
      expect(event).toMatchObject({
        jobId: fixture.selected.id,
        ...(replaced
          ? { status: "ok" }
          : { status: "error", error: "Cron job disabled by operator." }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const stored = accessor.loadSessionEntry({ agentId: "main", sessionKey: SESSION });
      if (replaced) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "session-changed" } }),
        );
        expect(stored).toMatchObject({ sessionId: "replacement-session" });
        expect(stored?.archivedAt).toBeUndefined();
      } else {
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(stored).toMatchObject({ sessionId: SESSION_ID, archivedAt: expect.any(Number) });
        const stopped = vi.fn();
        const teardown = fixture.stop().then(stopped);
        try {
          // Keep the core held across a worker round-trip before checking teardown.
          expect((await fixture.creator.read()).every((job) => !job.enabled)).toBe(true);
          expect(stopped).not.toHaveBeenCalled();
        } finally {
          releaseCore.resolve();
          await teardown;
        }
        expect(stopped).toHaveBeenCalledOnce();
      }
    } finally {
      releaseCore.resolve();
      await fixture.stop();
    }
  },
);
