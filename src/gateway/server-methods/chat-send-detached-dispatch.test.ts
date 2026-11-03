import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SubagentRegistryMutationRejectedError } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import * as chatAdmission from "./chat-send-admission.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

it("settles a detached dispatch failure when chat-run cleanup throws", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const sessionKey = "agent:main:detached-failure";
    const sessionId = "detached-session";
    const runId = "detached-run";
    const storePath = state.statePath("sessions.sqlite");
    const scope = { agentId: "main", sessionKey, sessionId, storePath };
    const cfg = {
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { enabled: false },
      session: { store: storePath },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const profile = ensureProfileForEmail("detached-failure@example.test");
    await replaceSessionEntry(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const client: GatewayClient = {
      connId: "detached-client",
      authenticatedUserProfile: gatewayProfile(profile.id),
      connect: gatewayConnect(["operator.read", "operator.write", "operator.admin"], {
        id: "cli",
        mode: "cli",
      }),
    };
    const context = createGatewayRequestContext(makeContextParams());
    const removeFaulted = createDeferred();
    const cleanupError = new Error("accepted chat-run cleanup failed");
    vi.mocked(context.removeChatRun).mockImplementation(() => {
      removeFaulted.resolve();
      throw cleanupError;
    });
    const originalAdmission = chatAdmission.admitChatSend;
    let admission: chatAdmission.AdmittedChatSend | undefined;
    // Admission is already awaited; leave detached dispatch completion unspied.
    const observeAdmission = vi
      .spyOn(chatAdmission, "admitChatSend")
      .mockImplementation(async (params) => {
        const result = await originalAdmission(params);
        if (result.ok) {
          admission = result.value;
        }
        return result;
      });
    const rejectDispatch = vi
      .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
      .mockRejectedValue(
        new SubagentRegistryMutationRejectedError("Replacement subagent cohort changed"),
      );
    try {
      const params = {
        sessionKey,
        sessionId,
        message: "Continue the completed task",
        idempotencyKey: runId,
      };
      const respond = vi.fn<RespondFn>();
      await handleChatSend({
        req: { type: "req", id: "detached-proof", method: "chat.send", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => true,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, response] = expectDefined(respond.mock.calls[0], "chat.send did not respond");
      expect([ok, response]).toEqual([true, expect.objectContaining({ runId, status: "started" })]);
      await removeFaulted.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const terminals = vi
        .mocked(context.broadcast)
        .mock.calls.filter(
          ([event, payload]) =>
            event === "chat" &&
            isRecord(payload) &&
            payload.runId === runId &&
            payload.state === "error",
        );
      expect(terminals).toHaveLength(1);
      expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
        ok: false,
        payload: {
          runId,
          status: "error",
          summary: expect.stringContaining("Replacement subagent cohort changed"),
        },
      });
      await expectDefined(admission, "dispatch did not acquire admission").gatewayWorkAdmission
        .released;
      expect(context.logGateway.warn).toHaveBeenCalledWith(
        expect.stringContaining("accepted chat-run cleanup failed"),
      );
      const transcript = await loadTranscriptEvents(scope);
      expect(
        transcript.filter(
          (event) =>
            isRecord(event) &&
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.role === "user",
        ),
      ).toHaveLength(1);
    } finally {
      rejectDispatch.mockRestore();
      admission?.cleanupAdmittedRun();
      await admission?.gatewayWorkAdmission.released;
      observeAdmission.mockRestore();
    }
  });
});
