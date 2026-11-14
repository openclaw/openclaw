import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerInferenceServiceStub } from "../worker-environments/inference-control.test-helpers.js";
import {
  adminRequestClient,
  broadcast,
  callQuestionRpc,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();

const desktop = { source: { kind: "environment" as const, environmentId: "worker:manual-step" } };
const question = {
  questionId: "required_action",
  header: "Manual step",
  question: "Complete the visible manual step.",
  desktop,
  options: [{ label: "Ready to recheck" }, { label: "Stop this task" }],
  isOther: false,
};

it.each([true, false])(
  "publishes only a desktop owned by the admitted task (matching=%s)",
  async (matching) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      setRuntimeConfigSnapshot({});
      const attachment = {
        agentId: requestParams.agentId,
        sessionKey: requestParams.sessionKey,
        sessionId: "manual-task",
        environmentId: matching ? desktop.source.environmentId : "worker:unrelated",
        ownerEpoch: 1,
        generation: 1,
      };
      await upsertSessionEntryCore(
        { agentId: requestParams.agentId, sessionKey: requestParams.sessionKey },
        { sessionId: attachment.sessionId, updatedAt: 1_000 },
      );
      const service = {
        ...createWorkerInferenceServiceStub(),
        findSessionAttachment: () => attachment,
        assertSessionAttachment: () => {},
        get: (environmentId: string) => ({
          environmentId,
          providerId: "synthetic",
          profileId: "desktop",
          leaseId: "lease-manual",
          resourceReceipt: null,
          sharedHost: false,
          state: "attached" as const,
          ownerEpoch: 1,
          createdAtMs: 1,
          idleSinceAtMs: null,
          destroyRequestedAtMs: null,
          attachedSessionIds: [attachment.sessionId],
          desktopAvailable: true,
          desktopApps: [],
          tunnelStatus: "connected" as const,
        }),
      };
      const result = await callQuestionRpc(
        "question.request",
        {
          ...requestParams,
          id: "desktop-human-step",
          sessionKey: "agent:main:spoofed",
          questions: [question],
        },
        { client: adminRequestClient, context: { workerEnvironmentService: service } },
      );
      expect(result[0], JSON.stringify(result[2])).toBe(matching);
      if (matching) {
        expect(manager.get("desktop-human-step")).toMatchObject({
          id: "desktop-human-step",
          sessionKey: requestParams.sessionKey,
          runId: requestParams.runId,
          status: "pending",
          questions: [question],
        });
        expect(broadcast).toHaveBeenCalledWith(
          "question.requested",
          expect.objectContaining({ id: "desktop-human-step", questions: [question] }),
          expect.anything(),
        );
      } else {
        expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
        expect(manager.get("desktop-human-step")).toBeNull();
        expect(broadcast).not.toHaveBeenCalled();
      }
    });
  },
);

it("refuses unbound clients and ordinary question cards for desktop handoffs", async () => {
  for (const input of [question, { ...question, questionId: "decision", isOther: true }]) {
    const result = await callQuestionRpc("question.request", {
      ...requestParams,
      questions: [input],
    });
    expect(result[0]).toBe(false);
    expect(result[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(broadcast).not.toHaveBeenCalled();
  }
});
