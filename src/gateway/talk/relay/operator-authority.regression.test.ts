import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../../test/helpers/promise.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../device-revocation.js";
import {
  createContext,
  createOperatorClient,
} from "../../server-plugin-in-process-dispatch.test-support.js";
import { createTalkClientGatewayControlOwner } from "../client-gateway-control.js";
import {
  controlBridge,
  controlContext,
  sessionTarget,
} from "../client-gateway-control.test-support.js";
import { retainTalkClientRunAuthority } from "../client-run-authority.js";

// Real device-source revocation must fence an awaited native control result.
// Disconnect/replacement coverage cannot catch a still-connected revoked principal;
// the former inline runtime fixture is retired. No production seam is required.
it("fences awaited native replies with the retained device-source authority", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = createContext();
    context.chatAbortControllers = new Map();
    context.resolveGatewayContext = () => context;
    const client = createOperatorClient({
      profileName: "native-revocation",
      scopes: ["operator.admin"],
    });
    const connection = new AbortController();
    const device = captureGatewayDeviceRevocation(
      context,
      { deviceId: "native-revocation", role: "operator" },
      () => !connection.signal.aborted,
      connection.signal,
    );
    const runAuthority = await retainTalkClientRunAuthority({
      client,
      context,
      hasCurrentClientAuthority: device.isCurrent,
    });
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    const respond = vi.fn();
    const owner = createTalkClientGatewayControlOwner({
      voiceSessionId: "native-operator-revocation",
      connId: "native-operator-revocation",
      sessionTarget,
      controlSource: "delegation",
      context: controlContext(),
      operatorAuthority: expectDefined(
        runAuthority.operatorAuthority,
        "retained operator authority",
      ),
      runToolAgentConsult: vi.fn(async () => ({ text: "unexpected" })),
      runAgentConsult: vi.fn(async () => ({ text: "unexpected" })),
      appendTranscript: vi.fn(async () => undefined),
      flushTranscript: vi.fn(async () => undefined),
      closeLogicalSession: vi.fn(async () => undefined),
      controlAgentRun: async () => {
        entered.resolve();
        await finish.promise;
        return {
          ok: true,
          mode: "status",
          sessionKey: sessionTarget.canonicalKey,
          active: false,
          message: "No active request.",
          speak: true,
          show: true,
          suppress: false,
        };
      },
    });
    owner.control.bindBridge(controlBridge());
    await owner.adoptProvider(async () => undefined);
    runAuthority.accept();
    owner.activate();
    try {
      expect(owner.control.handleDelegationInput?.("status", respond)).toBe("control");
      await withinTest(entered.promise, signal);
      invalidateGatewayDeviceRevocation(context, "native-revocation", "operator");
      expect(() => runAuthority.assertCurrent()).toThrow();
      expect(() => owner.assertOpen()).toThrow();
      finish.resolve();
      // Closing drains accepted controls, providing a terminal observation barrier.
      await withinTest(owner.close(), signal);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await owner.close();
      runAuthority.release();
      device.release();
    }
  });
});
