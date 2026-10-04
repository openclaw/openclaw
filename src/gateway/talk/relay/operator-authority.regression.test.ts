import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunOperatorAuthority,
  type AdmittedRunContext,
} from "../../../agents/admitted-run-context.js";
import {
  captureAgentHarnessCompletionCustody,
  runWithAgentHarnessCompletionCustody,
  type AgentHarnessCompletionCustody,
} from "../../../agents/agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "../../../agents/agent-harness-completion-scope.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../../agents/tools/gateway-caller-context.js";
import { captureAgentRunTerminalWriteContext } from "../../../infra/agent-run-terminal-writes.js";
import * as terminalWrites from "../../../infra/agent-run-terminal-writes.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { RealtimeVoiceAgentConsultRunner } from "../../../talk/provider-types.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../server-plugin-in-process-dispatch.test-support.js";
import { controlBridge } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { drainRelayTestSessions } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { usePersistentRelayTestState } from "./session-state.test-support.js";
import { relaySessions } from "./state.js";

const { runEmbeddedAgent } = vi.hoisted(() => ({ runEmbeddedAgent: vi.fn() }));
// mock-isolation: Substitute inference without provider or credential access; real admission and completion custody execute below.
vi.mock("../../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));

const sessionKey = "agent:main:main";
const activeRelaySessions = new Map<string, string>();
usePersistentRelayTestState(activeRelaySessions);

describe("Talk relay operator authority across setup and consult lifetimes", () => {
  const custodies: AgentHarnessCompletionCustody[] = [];
  let admitted: AdmittedRunContext[];
  let capturedAuthority: AdmittedRunOperatorAuthority | undefined;
  let callSequence: number;
  let onAdmitted: ((params: RunEmbeddedAgentParams) => void | Promise<void>) | undefined;

  beforeEach(() => {
    admitted = [];
    capturedAuthority = undefined;
    callSequence = 0;
    onAdmitted = undefined;
    runEmbeddedAgent.mockReset();
    // Replace only inference. Admission and Codex's startup completion-custody
    // boundary execute their real owners, with the real ambient setup request.
    runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const admission = expectDefined(params.preparedRunAdmission, "prepared admission");
      const run = await admission.admit("embedded");
      admitted.push(run);
      const identity = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          agentId: "main",
          sessionKey,
          admittedRunContext: run,
        }),
        "admitted caller",
      );
      await withGatewayToolCallerIdentity(identity, async () => {
        const scope = createAgentHarnessCompletionScope({
          requesterSessionKey: sessionKey,
          gatewayContextResolver: identity.gatewayContextResolver,
        });
        const custody = expectDefined(
          await captureAgentHarnessCompletionCustody(scope),
          "harness completion custody",
        );
        custodies.push(custody);
        expect(custody.isCurrent()).toBe(true);
        try {
          await onAdmitted?.(params);
          runWithAgentHarnessCompletionCustody(custody, scope, () => undefined);
        } finally {
          custody.release();
        }
      });
      return { payloads: [{ text: "Consult completed." }] };
    });
  });

  afterEach(async () => {
    custodies.splice(0).forEach((custody) => custody.release());
    await drainRelayTestSessions(activeRelaySessions);
  });

  async function createCall(
    options: {
      retain?: boolean;
      context?: ReturnType<typeof createContext>;
      constructionFailure?: "throw" | "close";
    } = {},
  ) {
    const cfg = { agents: { entries: { main: {} } } };
    const context = options.context ?? createContext();
    if (!options.context) {
      context.getRuntimeConfig = () => cfg;
      context.chatAbortControllers = new Map();
      context.broadcastToConnIds = vi.fn();
      context.resolveGatewayContext = () => context;
    }
    const client = createOperatorClient({ profileName: "relay-owner", scopes: ["operator.admin"] });
    const connId = `relay-client-${++callSequence}`;
    client.connId = connId;
    const connection = new AbortController();
    const device = captureGatewayDeviceRevocation(
      context,
      { deviceId: "relay-device", role: "operator" },
      () => !connection.signal.aborted,
      connection.signal,
    );
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority: device.isCurrent,
      }),
      "setup operator authority",
    );
    capturedAuthority = captured.authority;
    let consult: RealtimeVoiceAgentConsultRunner | undefined;
    try {
      const result = withPluginRuntimeGatewayRequestScope(
        {
          client,
          context,
          resolveGatewayContext: context.resolveGatewayContext,
          hasCurrentClientAuthority: device.isCurrent,
          isWebchatConnect: () => false,
        },
        () =>
          createTalkRealtimeRelaySession({
            cfg,
            context,
            connId,
            sessionTarget: prepareTalkSessionTarget(cfg, sessionKey),
            operatorAuthority: options.retain === false ? undefined : captured.authority,
            controlSource: "delegation",
            provider: {
              id: "relay-authority-test",
              label: "Relay authority test",
              isConfigured: () => true,
              createBridge: ({ runAgentConsult, onClose }) => {
                if (options.constructionFailure === "throw") {
                  throw new Error("provider construction failed");
                }
                if (options.constructionFailure === "close") {
                  onClose?.("error");
                }
                // A provider's later socket event inherits its construction context,
                // including a request capture whose setup hold has already ended.
                consult = AsyncResource.bind(expectDefined(runAgentConsult, "provider consult"));
                return controlBridge();
              },
            },
            providerConfig: {},
            instructions: "Answer briefly.",
            tools: [],
          }),
      );
      activeRelaySessions.set(result.relaySessionId, connId);
      return {
        context,
        consult: expectDefined(consult, "bound provider consult"),
        relay: expectDefined(relaySessions.get(result.relaySessionId), "active relay"),
        authority: captured.authority,
        revoke: () => invalidateGatewayDeviceRevocation(context, "relay-device", "operator"),
      };
    } finally {
      captured.release();
      device.release();
    }
  }

  it("reaches real completion custody on repeated delayed consults after setup is released", async () => {
    const call = await createCall();
    for (const prompt of ["first request", "second request"]) {
      await expect(call.consult({ prompt })).resolves.toEqual({ text: "Consult completed." });
    }
    expect(admitted).toHaveLength(2);
    for (const run of admitted) {
      expect(getAdmittedRunDelegatedAuthority(run)).toBeUndefined();
    }
    await closeRelaySession(call.relay, "completed");
    expect(call.authority.assertCurrent).toThrow("no longer active");
    await expect(call.consult({ prompt: "late request" })).rejects.toThrow("session is closed");
  });

  it("reproduces the original custody failure when the call does not retain setup authority", async () => {
    const call = await createCall({ retain: false });
    await expect(call.consult({ prompt: "delayed request" })).rejects.toThrow(
      "Gateway caller authority is no longer active",
    );
    expect(admitted).toHaveLength(1);
  });

  it("keeps an admitted consult alive through audio detach but rejects explicit device revocation", async () => {
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    onAdmitted = async () => {
      entered.resolve();
      await finish.promise;
    };
    const oldCall = await createCall();
    const pending = oldCall.consult({ prompt: "continue after detach" });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "consult did not reach custody");
      await closeRelaySession(oldCall.relay, "completed", { disposition: "detach" });
      expect(oldCall.authority.assertCurrent).not.toThrow();
      expect(custodies[0]?.isCurrent()).toBe(true);
      const newCall = await createCall({ context: oldCall.context });
      expect(newCall.authority).not.toBe(oldCall.authority);
      onAdmitted = undefined;
      await expect(newCall.consult({ prompt: "new call" })).resolves.toEqual({
        text: "Consult completed.",
      });
      newCall.revoke();
      await expect(newCall.consult({ prompt: "revoked call" })).rejects.toThrow("no longer active");
      expect(oldCall.authority.assertCurrent).toThrow("no longer active");
      expect(custodies[0]?.isCurrent()).toBe(false);
    } finally {
      finish.resolve();
      await expect(pending).rejects.toThrow("no longer active");
    }
    expect(oldCall.authority.assertCurrent).toThrow("no longer active");
  });

  it.each(["throw", "close"] as const)(
    "releases retained call authority when provider construction ends with %s",
    async (constructionFailure) => {
      await expect(createCall({ constructionFailure })).rejects.toThrow();
      expect(expectDefined(capturedAuthority, "setup authority").assertCurrent).toThrow(
        "no longer active",
      );
      expect(activeRelaySessions.size).toBe(0);
    },
  );

  it.for(["success", "failure", "abort", "revocation"] as const)(
    "drains accepted terminal writes before closing admission, preserving %s authority semantics",
    async (ending, { signal: testSignal }) => {
      const drainEntered = createDeferredCore();
      const finishWrite = createDeferredCore();
      const drain = terminalWrites.drainAgentRunTerminalWrites;
      const drainObserver = vi
        .spyOn(terminalWrites, "drainAgentRunTerminalWrites")
        .mockImplementation(async (instance) => {
          drainEntered.resolve();
          await drain(instance);
        });
      let write: ReturnType<typeof captureAgentRunTerminalWriteContext>;
      let persisted = false;
      onAdmitted = (params) => {
        write = expectDefined(captureAgentRunTerminalWriteContext(params.runId), "terminal write");
        const captured = write;
        captured.track(
          finishWrite.promise.then(() => {
            captured.run(() => {
              persisted = true;
            });
          }),
        );
        if (ending === "failure") {
          throw new Error("provider failed");
        }
      };
      const call = await createCall();
      const abort = new AbortController();
      const pending = call.consult({ prompt: "persist result", signal: abort.signal });
      const checked =
        ending === "success"
          ? expect(pending).resolves.toEqual({ text: "Consult completed." })
          : expect(pending).rejects.toThrow();
      try {
        await awaitGateBeforeSettlement(
          drainEntered.promise,
          pending,
          "admission closed without draining",
        );
        expect(expectDefined(write, "write").assertCurrent).not.toThrow();
        expect(persisted).toBe(false);
        if (ending === "abort" || ending === "revocation") {
          if (ending === "abort") {
            abort.abort(new Error("owner cancelled"));
          } else {
            call.revoke();
          }
          expect(expectDefined(write, "write").assertCurrent).toThrow();
          // Revocation must also settle the consult while the rejected write
          // remains pending, not only after persistence eventually unblocks.
          await withinTest(checked, testSignal);
        }
      } finally {
        finishWrite.resolve();
        try {
          await checked;
        } finally {
          drainObserver.mockRestore();
        }
      }
      expect(persisted).toBe(ending === "success" || ending === "failure");
      expect(expectDefined(write, "write").assertCurrent).toThrow();
    },
  );
});
