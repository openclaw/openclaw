import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayTurnIssuerAdmission } from "../operator-run-authority.js";
import { handleGatewayRequest } from "../server-methods.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

it("chat.abort cancels durable inputs beyond the first page while preserving another device's input", async () => {
  await withOpenClawTestState({ label: "abort-durable-pages" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const first = await createOriginalIssuerFixture(state, 0, "current grant");
    const other = await createOriginalIssuerFixture(state, 1, "current grant", false, first);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:abort-durable-pages",
      sessionId: "abort-durable-pages",
    };
    const runIds = Array.from({ length: 25 }, (_, index) => `durable-own-${index}`);
    try {
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        lifecycleRevision: "abort-durable-lifecycle",
        updatedAt: 1,
        status: "done",
        createdActor: { type: "human", source: "profile", id: first.profile.id },
      });
      const requests = [
        ...runIds.slice(0, 10).map((runId) => ({ runId, issuer: first })),
        { runId: "durable-other-device", issuer: other },
        ...runIds.slice(10).map((runId) => ({ runId, issuer: first })),
      ];
      for (const { runId, issuer } of requests) {
        const authority = expectDefined(issuer.original, "original issuer").authority;
        const turnIssuerAdmission = expectDefined(
          captureGatewayTurnIssuerAdmission({
            authority,
            ...scope,
            lifecycleRevision: "abort-durable-lifecycle",
            runId,
          }),
          "durable original issuer admission",
        );
        const receipt = expectDefined(
          await stageSessionPendingInput(scope, {
            runId,
            message: {
              role: "user",
              content: `Accepted ${runId}`,
              timestamp: 1,
              idempotencyKey: `${runId}:user`,
            },
            turnIssuerAdmission,
            assertCurrent: authority.assertCurrent,
          }),
          "accepted durable input",
        );
        // Retire process-local custody; Stop must find the accepted rows in SQLite.
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
      expect(first.context.chatAbortControllers.size).toBe(0);
      expect(first.context.chatQueuedTurns.size).toBe(0);
      await initializeSessionReadContext(first.context);
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "abort-durable-pages",
          method: "chat.abort",
          params: { agentId: scope.agentId, sessionKey: scope.sessionKey },
        },
        client: first.client,
        context: first.context,
        respond,
        isWebchatConnect: () => true,
        hasCurrentClientAuthority: first.deviceSource.isCurrent,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
        ok: true,
        aborted: true,
        runIds,
      });
      const persisted = await listSessionPendingInputs(scope);
      expect(persisted.total).toBe(26);
      const older = await listSessionPendingInputs(scope, {
        before: expectDefined(persisted.nextBefore, "older accepted inputs"),
      });
      const items = [...older.items, ...persisted.items];
      expect(
        items.filter((input) => input.state === "cancelled").map((input) => input.runId),
      ).toEqual(runIds);
      expect(items.filter((input) => input.state !== "cancelled")).toMatchObject([
        { runId: "durable-other-device", state: "interrupted" },
      ]);
    } finally {
      for (const issuer of [first, other]) {
        issuer.original?.release();
        issuer.deviceSource.release();
      }
      first.runtime.close();
      await first.work.drain();
      await disposeSessionReadContexts();
      vi.unstubAllEnvs();
    }
  });
});
