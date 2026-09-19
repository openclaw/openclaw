// Imported by agent.test.ts to reuse its existing mocked runtime graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import * as userTurn from "../agent-turn/agent-run-user-turn.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
} from "../device-revocation.js";
import { agentHandlers } from "./agent.js";
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  makeContext,
  prime,
} from "./agent.test-harness.js";
import type { RespondFn } from "./types.js";

describe("gateway agent caller authority custody", () => {
  beforeEach(describe1BeforeEach0);
  afterEach(describe1AfterEach1);

  it("releases the original caller when the acceptance publisher throws", async () => {
    prime();
    const prepareInput = userTurn.prepareAgentRunUserTurn;
    let preparedInput: Awaited<ReturnType<typeof prepareInput>> | undefined;
    vi.spyOn(userTurn, "prepareAgentRunUserTurn").mockImplementationOnce(async (params) => {
      const prepared = await prepareInput(params);
      preparedInput = prepared;
      vi.spyOn(expectDefined(prepared.recorder, "input recorder missing"), "finishPendingInput");
      return prepared;
    });
    const context = makeContext();
    const caller = captureGatewayDeviceRevocation(
      context,
      { deviceId: "acceptance-device", role: "operator" },
      () => true,
    );
    const failure = new Error("acceptance publisher failed");
    const runId = "idem-acceptance-publisher-failure";
    const respond = vi.fn<RespondFn>((ok, payload) => {
      expect(ok).toBe(true);
      expect(payload).toMatchObject({ runId, status: "accepted" });
      caller.release();
      expect(caller.isCurrent()).toBe(true);
      throw failure;
    });
    try {
      await expect(
        expectDefined(
          agentHandlers.agent,
          "agent handler missing",
        )({
          params: { message: "hi", sessionKey: "agent:main:main", idempotencyKey: runId },
          req: { type: "req", id: runId, method: "agent" },
          context,
          client: null,
          isWebchatConnect: () => false,
          respond,
          hasCurrentClientAuthority: caller.isCurrent,
        }),
      ).rejects.toBe(failure);
      expect(respond).toHaveBeenCalledOnce();
      expect(getAgentTestMocks().agentCommand).not.toHaveBeenCalled();
      expect(caller.isCurrent()).toBe(false);
      const runtime = await expectDefined(
        vi.mocked(acquireAgentRunPreparedModelRuntime).mock.results.at(-1)?.value,
        "prepared runtime missing",
      );
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      expect(preparedInput?.recorder?.finishPendingInput).toHaveBeenCalledExactlyOnceWith(
        "interrupted",
      );
    } finally {
      caller.release();
      closeGatewayDeviceRevocation(context);
    }
  });
});
