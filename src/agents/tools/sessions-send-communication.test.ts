import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  communicationEntryBinding,
  type CommunicationEndpoint,
} from "../../sessions/communication-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
const state = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  rows: new Map<string, CommunicationEndpoint>(),
  approve: vi.fn(),
  assertCaller: vi.fn(),
  task: undefined as unknown,
  caller: { agentId: "main", sessionKey: "agent:main:source" },
}));
vi.mock("./gateway-caller-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-caller-context.js")>()),
  getGatewayToolCallerIdentity: () => state.caller,
  captureGatewayToolCallerAssertion: () => state.assertCaller,
  resolveGatewayToolOperatorSelection: () => ({ assertCurrent: state.assertCaller }),
}));
vi.mock("./in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./in-process-gateway.js")>()),
  callAgentToolGatewayRequest: vi.fn(),
  getInProcessGatewayToolContext: () => ({ getRuntimeConfig: () => state.config }),
}));
vi.mock("../../gateway/session-communication-approval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-communication-approval.js")>()),
  requestSessionCommunicationApproval: (...args: unknown[]) => state.approve(...args),
}));
vi.mock("../../gateway/session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/session-utils-store-worker.js")>()),
  resolveGatewaySessionStoreTargetInWorker: async ({ key }: { key: string }) => {
    const row = state.rows.get(key);
    if (!row) {
      throw new Error("missing session");
    }
    return {
      agentId: row.agentId,
      canonicalKey: key,
      storePath: row.storePath,
      store: { [key]: row.entry },
    };
  },
}));
vi.mock("../embedded-agent-runner/run-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../embedded-agent-runner/run-state.js")>()),
  registerActiveEmbeddedRunHumanInputWait: vi.fn(),
}));
vi.mock("../subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../subagents/registry/subagent-registry-read.js")>()),
  getLatestLiveSubagentRunByChildSessionKey: () => state.task,
}));
function endpoint(name: string, entry: Partial<SessionEntry> = {}): CommunicationEndpoint {
  const row = {
    agentId: "main",
    sessionKey: "agent:main:" + name,
    storePath: "/sessions",
    entry: { sessionId: name, updatedAt: 1, ...entry },
  };
  state.rows.set(row.sessionKey, row);
  return row;
}
function operation(source = endpoint("source"), target = endpoint("target")) {
  const callGateway = vi.mocked(callAgentToolGatewayRequest);
  return { config: state.config, source, target, message: "exact peer message", callGateway };
}
beforeEach(() => {
  state.config = {};
  state.rows.clear();
  state.approve.mockReset().mockResolvedValue(undefined);
  vi.mocked(callAgentToolGatewayRequest).mockReset();
  state.assertCaller.mockReset();
  state.task = undefined;
  vi.spyOn(runtimeConfig, "getRuntimeConfig").mockImplementation(() => state.config);
});
afterEach(() => vi.restoreAllMocks());
describe("sessions_send communication boundary", () => {
  it.each(["send", "receive"] as const)(
    "never %s denies same-agent peers before any prompt or delivery",
    async (direction) => {
      const input = operation(
        endpoint("source", direction === "send" ? { communication: { send: "never" } } : {}),
        endpoint("target", direction === "receive" ? { communication: { receive: "never" } } : {}),
      );
      await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("disabled");
      expect(state.approve).not.toHaveBeenCalled();
      expect(input.callGateway).not.toHaveBeenCalled();
    },
  );
  it("default always fences the final host admission without taking completion custody", async () => {
    const input = operation();
    input.callGateway.mockImplementation(async (request) => {
      request.sessionMutationCommitGuard?.();
      return { status: "accepted", runId: "accepted-run" };
    });
    const gate = await prepareSessionsSendCommunication(input);
    await expect(
      gate.callGateway({
        method: "agent",
        params: { agentId: "main", sessionKey: input.target.sessionKey, message: input.message },
      }),
    ).resolves.toEqual({ status: "accepted", runId: "accepted-run" });
    expect(state.approve).not.toHaveBeenCalled();
    gate.close();
    // Completion now belongs to the Gateway. Closing this gate creates no cancellation work.
    expect(input.callGateway).toHaveBeenCalledOnce();
  });
  it("asks sender then recipient for exact content and waits for both human decisions", async () => {
    const input = operation(
      endpoint("source", { communication: { send: "ask" } }),
      endpoint("target", { communication: { receive: "ask" } }),
    );
    const send = createDeferredCore();
    const receive = createDeferredCore();
    const first = createDeferredCore();
    const second = createDeferredCore();
    state.approve
      .mockImplementationOnce(() => {
        first.resolve();
        return send.promise;
      })
      .mockImplementationOnce(() => {
        second.resolve();
        return receive.promise;
      });
    const pending = prepareSessionsSendCommunication(input);
    await first.promise;
    expect(input.callGateway).not.toHaveBeenCalled();
    send.resolve();
    await second.promise;
    expect(state.approve.mock.calls.map(([request]) => request.approval.direction)).toEqual([
      "send",
      "receive",
    ]);
    expect(state.approve.mock.calls.every(([request]) => request.message === input.message)).toBe(
      true,
    );
    expect(input.callGateway).not.toHaveBeenCalled();
    receive.resolve();
    (await pending).close();
  });
  it.each(["refused", "expired", "cancelled"])(
    "%s never delivers or releases a backlog",
    async (reason) => {
      const input = operation(endpoint("source", { communication: { send: "ask" } }));
      state.approve.mockRejectedValue(new Error(reason));
      await expect(prepareSessionsSendCommunication(input)).rejects.toThrow(reason);
      state.config = { session: { communication: { send: "always" } } };
      expect(input.callGateway).not.toHaveBeenCalled();
    },
  );
  it("rejects policy changes during approval", async () => {
    const input = operation(endpoint("source", { communication: { send: "ask" } }));
    state.approve.mockImplementation(async () => {
      endpoint("target", { communication: { receive: "never" } });
    });
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow(
      "changed before delivery",
    );
    expect(input.callGateway).not.toHaveBeenCalled();
  });
  it("does not launder parent restrictions through child overrides", async () => {
    endpoint("parent", { communication: { send: "never" } });
    const input = operation(
      endpoint("source", {
        spawnedBy: "agent:main:parent",
        parentSessionId: "parent",
        communication: { send: "always" },
      }),
    );
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("disabled");
  });
  it("only live exact owned tasks get the guidance exception", async () => {
    const source = endpoint("source", { communication: { send: "never" } });
    const target = endpoint("target", {
      communication: { receive: "never" },
      spawnedBy: source.sessionKey,
      parentSessionId: "source",
    });
    state.task = {
      runId: "task",
      requesterSessionKey: source.sessionKey,
      requesterAgentId: "main",
    };
    const gate = await prepareSessionsSendCommunication(operation(source, target));
    expect(gate.ownedTask).toBe(true);
    state.task = undefined;
    expect(gate.assertCurrent).toThrow("authority changed");
    gate.close();
    await expect(prepareSessionsSendCommunication(operation(source, target))).rejects.toThrow(
      "disabled",
    );
  });
  it("survives ordinary metadata publication but rejects changed permissions", async () => {
    const input = operation();
    const gate = await prepareSessionsSendCommunication(input);
    const publish = (entry: SessionEntry) =>
      sessionChanges.emit({
        agentId: "main",
        sessionKey: input.target.sessionKey,
        storePath: "/sessions",
        facts: {
          kind: "entry",
          previousSessionId: "target",
          sessionId: "target",
          category: null,
          clearMembers: false,
          communicationBinding: communicationEntryBinding(entry),
        },
      });
    publish({ ...input.target.entry!, updatedAt: 9 });
    expect(gate.assertCurrent).not.toThrow();
    publish({ ...input.target.entry!, communication: { receive: "never" } });
    expect(gate.assertCurrent).toThrow("changed");
    gate.close();
  });
  it("worker revocation and target redirection cannot pass admission", async () => {
    const input = operation();
    const source = vi.fn();
    const gate = await prepareSessionsSendCommunication({ ...input, assertSourceCurrent: source });
    await expect(
      gate.callGateway({ method: "agent", params: { sessionKey: "agent:main:other" } }),
    ).rejects.toThrow("redirected");
    source.mockImplementation(() => {
      throw new Error("worker revoked");
    });
    await expect(
      gate.callGateway({ method: "agent", params: { sessionKey: input.target.sessionKey } }),
    ).rejects.toThrow("worker revoked");
    expect(input.callGateway).not.toHaveBeenCalled();
    gate.close();
  });
  it("denies a missing configured target before creating it and binds only its approved creation", async () => {
    const missing = { ...endpoint("target"), entry: undefined };
    state.rows.set(missing.sessionKey, missing);
    const input = operation(endpoint("source", { communication: { send: "never" } }), missing);
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("disabled");
    expect(input.callGateway).not.toHaveBeenCalled();
    const gate = await prepareSessionsSendCommunication({
      ...operation(endpoint("source"), missing),
      ensureTarget: async (assertCurrent) => {
        assertCurrent();
        return endpoint("target");
      },
    });
    expect(gate.assertCurrent).not.toThrow();
    gate.close();
  });

  it("rejects an adapter changing the exact request before the host commit", async () => {
    const input = operation();
    input.callGateway.mockImplementation(async (request) => {
      if (!isRecord(request.params)) {
        throw new Error("missing request");
      }
      request.params.message = "different message";
      request.sessionMutationCommitGuard?.();
      return undefined;
    });
    const gate = await prepareSessionsSendCommunication(input);
    await expect(
      gate.callGateway({
        method: "agent",
        params: { agentId: "main", sessionKey: input.target.sessionKey, message: input.message },
      }),
    ).rejects.toThrow("input changed");
    gate.close();
  });
  it("provenance strings cannot turn an optional peer send into task-owned work", async () => {
    const input = operation(endpoint("source", { communication: { send: "never" } }));
    await expect(
      prepareSessionsSendCommunication({
        ...input,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
          sourceRole: "subagent",
        },
      }),
    ).rejects.toThrow("disabled");
    expect(input.callGateway).not.toHaveBeenCalled();
  });

  it("same-session source replies are not peer communication", async () => {
    const source = endpoint("source", { communication: { send: "never", receive: "never" } });
    const gate = await prepareSessionsSendCommunication(operation(source, source));
    expect(state.approve).not.toHaveBeenCalled();
    gate.close();
  });
  it.each(["self", "cross-agent"] as const)(
    "always cannot override the existing %s access ceiling",
    async (restriction) => {
      state.config = {
        tools: {
          sessions: { visibility: restriction === "self" ? "self" : "all" },
          agentToAgent: { enabled: false },
        },
      };
      const input = operation();
      if (restriction === "cross-agent") {
        input.target = { ...input.target, agentId: "peer", sessionKey: "agent:peer:target" };
        state.rows.set(input.target.sessionKey, input.target);
      }
      await expect(prepareSessionsSendCommunication(input)).rejects.toThrow();
      expect(state.approve).not.toHaveBeenCalled();
      expect(input.callGateway).not.toHaveBeenCalled();
    },
  );

  it("refuses a config replacement between the initial access check and peer preparation", async () => {
    const input = operation();
    state.config = { tools: { sessions: { visibility: "self" } } };
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow();
    expect(input.callGateway).not.toHaveBeenCalled();
  });

  it("does not widen a denied operation by adopting a newer permissive config", async () => {
    state.config = { tools: { sessions: { visibility: "self" } } };
    const input = operation();
    state.config = {};
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow();
    expect(input.callGateway).not.toHaveBeenCalled();
  });

  it("rechecks config after human approval and at final dispatch", async () => {
    const input = operation(endpoint("source", { communication: { send: "ask" } }));
    state.approve.mockImplementation(async () => {
      state.config = { tools: { sessions: { visibility: "self" } } };
    });
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("policy changed");
    expect(input.callGateway).not.toHaveBeenCalled();
    state.config = {};
    const next = operation();
    const gate = await prepareSessionsSendCommunication(next);
    state.config = { tools: { sessions: { visibility: "self" } } };
    await expect(
      gate.callGateway({
        method: "agent",
        params: { agentId: "main", sessionKey: next.target.sessionKey, message: next.message },
      }),
    ).rejects.toThrow("policy changed");
    expect(next.callGateway).not.toHaveBeenCalled();
    gate.close();
  });

  it.each(["message", "agentId", "source"] as const)(
    "rejects changed %s before host admission",
    async (field) => {
      const input = operation();
      const gate = await prepareSessionsSendCommunication(input);
      const params = {
        agentId: "main",
        sessionKey: input.target.sessionKey,
        message: input.message,
        ...(field === "message"
          ? { message: "unseen" }
          : field === "agentId"
            ? { agentId: "peer" }
            : { inputProvenance: { sourceSessionKey: "foreign" } }),
      };
      await expect(gate.callGateway({ method: "agent", params })).rejects.toThrow("redirected");
      expect(input.callGateway).not.toHaveBeenCalled();
      gate.close();
    },
  );
  it.each(["never", "sender-refusal"] as const)(
    "%s never creates empty target metadata",
    async (reason) => {
      state.config = {
        session: { communication: { send: "ask", receive: reason === "never" ? "never" : "ask" } },
      };
      const missing = { ...endpoint("target"), entry: undefined };
      state.rows.set(missing.sessionKey, missing);
      const ensureTarget = vi.fn(async () => endpoint("target"));
      state.approve.mockRejectedValueOnce(new Error("refused"));
      await expect(
        prepareSessionsSendCommunication({
          ...operation(endpoint("source"), missing),
          ensureTarget,
        }),
      ).rejects.toThrow();
      expect(ensureTarget).not.toHaveBeenCalled();
      if (reason === "never") {
        expect(state.approve).not.toHaveBeenCalled();
      }
    },
  );

  it("freezes the approved bytes independently of caller-owned option objects", async () => {
    const input = operation();
    const gate = await prepareSessionsSendCommunication(input);
    input.message = "changed after approval";
    await expect(
      gate.callGateway({
        method: "agent",
        params: { agentId: "main", sessionKey: input.target.sessionKey, message: input.message },
      }),
    ).rejects.toThrow("redirected");
    expect(input.callGateway).not.toHaveBeenCalled();
    gate.close();
  });
});
