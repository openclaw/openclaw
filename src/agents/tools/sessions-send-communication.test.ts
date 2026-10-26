import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { runSessionRegistryMaintenanceForStore } from "../../config/sessions/session-registry-maintenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSessionSendDeliveryAdmission } from "../../gateway/session-send-delivery.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  communicationEntryBinding,
  type CommunicationEndpoint,
} from "../../sessions/communication-admission.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { acceptCompactionSuccessor } from "../embedded-agent-runner/compaction-successor.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
const tempDirs = useSessionStoreTempDirs(afterAll, "sessions-send-lineage-");
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
function endpoint(
  name: string,
  entry: Partial<SessionEntry> = {},
  agentId = "main",
  storePath = "/sessions",
): CommunicationEndpoint {
  const row = {
    agentId,
    sessionKey: `agent:${agentId}:${name}`,
    storePath,
    entry: { sessionId: name, updatedAt: 1, ...entry },
  };
  state.rows.set(row.sessionKey, row);
  return row;
}
async function rotatedParent() {
  const parent = endpoint("parent");
  parent.storePath = path.join(tempDirs.make(), "sessions.sqlite");
  for (const sessionId of ["original", "rollover", "recovered"]) {
    await upsertSessionEntryCore(parent, { sessionId, updatedAt: 1 });
  }
  const entry: SessionEntry = {
    sessionId: "recovered",
    previousSessionId: "rollover",
    updatedAt: 1,
  };
  parent.entry = entry;
  return { parent, entry };
}
function operation(source = endpoint("source"), target = endpoint("target")) {
  const callGateway = vi.mocked(callAgentToolGatewayRequest);
  return { config: state.config, source, target, message: "exact peer message", callGateway };
}
function agentRequest(input: Input, extra: Record<string, unknown> = {}) {
  return {
    method: "agent" as const,
    params: {
      agentId: input.target.agentId,
      sessionKey: input.target.sessionKey,
      message: input.message,
      ...extra,
    },
  };
}
function threadConfig(allowThreadTargets: boolean | undefined): OpenClawConfig {
  return { tools: { sessions: { allowThreadTargets } } };
}
const askSend = { communication: { send: "ask" } } satisfies Partial<SessionEntry>;
const neverSend = { communication: { send: "never" } } satisfies Partial<SessionEntry>;
const askReceive = { communication: { receive: "ask" } } satisfies Partial<SessionEntry>;
const neverReceive = { communication: { receive: "never" } } satisfies Partial<SessionEntry>;
const selfOnly: OpenClawConfig = { tools: { sessions: { visibility: "self" } } };
function expectNoApprovalOrDelivery(input: ReturnType<typeof operation>) {
  expect(input.callGateway).not.toHaveBeenCalled();
  expect(state.approve).not.toHaveBeenCalled();
}
type Input = Parameters<typeof prepareSessionsSendCommunication>[0];
type Gate = Awaited<ReturnType<typeof prepareSessionsSendCommunication>>;
async function withGate(input: Input, check: (gate: Gate) => void | Promise<void>) {
  const gate = await prepareSessionsSendCommunication(input);
  try {
    await check(gate);
  } finally {
    gate.close();
  }
}
async function denied(input: Input, error?: string) {
  await expect(prepareSessionsSendCommunication(input)).rejects.toThrow(error);
  expect(input.callGateway).not.toHaveBeenCalled();
}
async function delivered(input: Input) {
  await withGate(input, async (gate) => {
    await gate.callGateway(agentRequest(input));
    expect(input.callGateway).toHaveBeenCalledOnce();
  });
}
async function deniedDispatch(input: Input, extra: Record<string, unknown>, error: string) {
  await withGate(input, async (gate) => {
    await expect(gate.callGateway(agentRequest(input, extra))).rejects.toThrow(error);
    expect(input.callGateway).not.toHaveBeenCalled();
  });
}
function childOf(parent: CommunicationEndpoint, entry: Partial<SessionEntry> = {}) {
  return endpoint("target", {
    spawnedBy: parent.sessionKey,
    parentSessionId: parent.entry!.sessionId,
    ...entry,
  });
}
function changed(
  input: Input,
  fields: Omit<Extract<SessionRowChange, { sessionKey: string }>, "sessionKey" | "agentId"> = {},
) {
  sessionChanges.emit({ agentId: "main", sessionKey: input.target.sessionKey, ...fields });
}
function missingTarget() {
  const target = { ...endpoint("target"), entry: undefined };
  state.rows.set(target.sessionKey, target);
  return target;
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
  it.each([false, true])(
    "retains durable delivery identity for owned-task fallback=%s",
    async (ownedTask) => {
      const source = endpoint("source");
      const target = ownedTask ? childOf(source) : endpoint("target");
      if (ownedTask) {
        state.task = {
          runId: "task",
          requesterSessionKey: source.sessionKey,
          requesterAgentId: "main",
        };
      }
      const input = operation(source, target);
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceTool: "sessions_send",
        sourceSessionKey: input.source.sessionKey,
      };
      input.callGateway.mockImplementation(async () => {
        const admitted = readSessionSendDeliveryAdmission({
          agentId: "main",
          sessionKey: input.target.sessionKey,
          sessionId: "target",
          runId: "saved-peer",
        });
        expect(admitted).toBeDefined();
        expect(admitted!.delivery.source).not.toHaveProperty("lifecycleRevision");
        expect(admitted!.delivery.target).not.toHaveProperty("lifecycleRevision");
      });
      await withGate({ ...input, inputProvenance }, async (gate) => {
        await (ownedTask ? gate.callDurableGateway : gate.callGateway)(
          agentRequest(input, { idempotencyKey: "saved-peer", inputProvenance }),
        );
        expect(input.callGateway).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([
    [undefined, undefined, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ] as const)(
    "thread admission requires captured=%s and current=%s permission",
    async (captured, current, allowed) => {
      state.config = threadConfig(captured);
      const input = operation(undefined, endpoint("discord:channel:123:thread:456"));
      state.config = threadConfig(current);
      const pending = prepareSessionsSendCommunication(input);
      if (allowed) {
        (await pending).close();
      } else {
        await expect(pending).rejects.toThrow("cannot target a thread session");
      }
      expectNoApprovalOrDelivery(input);
    },
  );

  it("revocation at the final thread admission has no target effect", async () => {
    state.config = threadConfig(true);
    const input = operation(undefined, endpoint("discord:channel:123:thread:456"));
    const effect = vi.fn();
    input.callGateway.mockImplementation(async (request) => {
      state.config = threadConfig(false);
      request.sessionMutationCommitGuard?.();
      effect();
    });
    await withGate(input, async (gate) => {
      await expect(gate.callGateway(agentRequest(input))).rejects.toThrow("policy changed");
      expect(effect).not.toHaveBeenCalled();
    });
  });

  it.each(["send", "receive"] as const)(
    "never %s denies same-agent peers before any prompt or delivery",
    async (direction) => {
      const input = operation(
        endpoint("source", direction === "send" ? neverSend : {}),
        endpoint("target", direction === "receive" ? neverReceive : {}),
      );
      await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("disabled");
      expectNoApprovalOrDelivery(input);
    },
  );
  it("rejects policy changes during approval", async () => {
    const input = operation(endpoint("source", askSend));
    state.approve.mockImplementation(async () => {
      endpoint("target", neverReceive);
    });
    await denied(input, "changed before delivery");
  });
  it("does not launder parent restrictions through child overrides", async () => {
    endpoint("parent", neverSend);
    const input = operation(
      endpoint("source", {
        spawnedBy: "agent:main:parent",
        parentSessionId: "parent",
        communication: { send: "always" },
      }),
    );
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow("disabled");
  });
  it("delivers parent and peer sends through recorded same-key rollover/recovery lineage", async () => {
    const { parent, entry: parentEntry } = await rotatedParent();
    const target = endpoint("child", {
      spawnedBy: parent.sessionKey,
      parentSessionId: "original",
    });
    for (const source of [parent, endpoint("source")]) {
      const input = operation(source, target);
      input.callGateway.mockClear();
      await delivered(input);
    }
    parentEntry.communication = { receive: "never" };
    vi.mocked(callAgentToolGatewayRequest).mockClear();
    await denied(operation(undefined, target), "disabled");
  });
  it("keeps an expired cron ancestor reachable through an archived intermediary until its cross-agent child is archived", async () => {
    const expiredAt = Date.now() - 8 * 24 * 60 * 60_000;
    const parent = endpoint("cron:dispatch:run:old", { updatedAt: expiredAt });
    parent.storePath = path.join(tempDirs.make(), "sessions.sqlite");
    const ancestor = endpoint("subagent:archived", {
      spawnedBy: parent.sessionKey,
      parentSessionId: parent.entry!.sessionId,
      archivedAt: Date.now(),
    });
    ancestor.storePath = parent.storePath;
    const target = endpoint(
      "subagent:child",
      {
        updatedAt: Date.now(),
        spawnedBy: ancestor.sessionKey,
        parentSessionId: ancestor.entry!.sessionId,
      },
      "worker",
      path.join(tempDirs.make(), "sessions.sqlite"),
    );
    state.config = { tools: { agentToAgent: { enabled: true, allow: ["*"] } } };
    await replaceSessionEntry(parent, parent.entry!);
    expect(loadSessionEntry(parent)?.updatedAt).toBe(expiredAt);
    await replaceSessionEntry(ancestor, ancestor.entry!);
    await replaceSessionEntry(target, target.entry!);
    const maintain = (apply: boolean) =>
      runSessionRegistryMaintenanceForStore({
        agentId: "main",
        storePath: parent.storePath,
        childStores: [parent, target],
        apply,
        retentionMs: 7 * 24 * 60 * 60_000,
        runningCronJobIds: new Set(),
      });
    for (const apply of [false, true]) {
      expect((await maintain(apply)).pruned).toBe(0);
    }
    parent.entry = loadSessionEntry(parent);
    expect(parent.entry).toBeDefined();
    const input = operation(undefined, target);
    await delivered(input);
    parent.entry!.communication = { receive: "never" };
    input.callGateway.mockClear();
    await denied(input, "disabled");
    await upsertSessionEntryCore(target, { archivedAt: Date.now() });
    expect((await maintain(true)).pruned).toBe(1);
    expect(loadSessionEntry(parent)).toBeUndefined();
  });
  it("refuses delivery when parent lineage changes during approval", async () => {
    const { parent, entry } = await rotatedParent();
    const input = operation(
      undefined,
      endpoint("child", {
        spawnedBy: parent.sessionKey,
        parentSessionId: "original",
        ...askReceive,
      }),
    );
    state.approve.mockImplementation(async () => {
      await upsertSessionEntryCore(parent, { previousSessionId: undefined });
      entry.previousSessionId = undefined;
    });
    await denied(input, "changed before delivery");
  });
  it("keeps owner-committed compaction lineage changes admissible", async () => {
    const input = operation();
    input.target.storePath = path.join(tempDirs.make(), "sessions.sqlite");
    await upsertSessionEntryCore(input.target, input.target.entry!);
    await withGate(input, async (gate) => {
      await acceptCompactionSuccessor({
        currentTarget: { ...input.target, sessionId: "target" },
        expectedEntry: {
          sessionId: "target",
          lifecycleRevision: undefined,
          activeWriterRunId: undefined,
        },
        assertActive: gate.assertCurrent,
        result: {
          ok: true,
          compacted: true,
          result: {
            summary: "Compacted context",
            tokensBefore: 2,
            tokensAfter: 1,
            sessionId: "compacted",
          },
        },
        onCommitted: ({ entry }) =>
          state.rows.set(input.target.sessionKey, { ...input.target, entry }),
      });
      await gate.callGateway(agentRequest(input));
      expect(input.callGateway).toHaveBeenCalledOnce();
    });
  });
  it.each([undefined, "missing-original", "foreign-original"])(
    "refuses unconnected parent lineage (predecessor=%s) with respawn guidance",
    async (previousSessionId) => {
      const parent = endpoint("parent");
      parent.storePath = path.join(tempDirs.make(), "sessions.sqlite");
      if (previousSessionId === "foreign-original") {
        await upsertSessionEntryCore(
          { ...parent, sessionKey: "agent:main:other-parent" },
          {
            sessionId: previousSessionId,
            updatedAt: 1,
          },
        );
      }
      await upsertSessionEntryCore(parent, {
        sessionId: "parent",
        previousSessionId,
        updatedAt: 1,
      });
      await denied(
        operation(
          undefined,
          endpoint("child", {
            spawnedBy: parent.sessionKey,
            parentSessionId: previousSessionId ?? "missing-original",
          }),
        ),
        "The child's parent session lineage changed; re-spawn the child.",
      );
    },
  );
  it("does not request fresh consent during durable delivery recovery", async () => {
    const input = operation(endpoint("source", askSend));
    await expect(
      prepareSessionsSendCommunication({ ...input, allowApproval: false }),
    ).rejects.toThrow("fresh human communication approval");
    expectNoApprovalOrDelivery(input);
  });
  it("provenance strings cannot turn an optional peer send into task-owned work", async () => {
    const input = operation(endpoint("source", neverSend));
    await denied(
      {
        ...input,
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
          sourceRole: "subagent",
        },
      },
      "disabled",
    );
  });
  it.each([
    [{}, selfOnly],
    [selfOnly, {}],
  ])("config replacement from %j to %j cannot widen access", async (captured, current) => {
    state.config = captured;
    const input = operation();
    state.config = current;
    await denied(input);
    expectNoApprovalOrDelivery(input);
  });
  it("asks sender then recipient for exact content and waits for both human decisions", async () => {
    const input = operation(endpoint("source", askSend), endpoint("target", askReceive));
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
    expect(state.approve.mock.calls.map(([request]) => request)).toMatchObject([
      { approval: { direction: "send" }, message: input.message },
      { approval: { direction: "receive" }, message: input.message },
    ]);
    expect(input.callGateway).not.toHaveBeenCalled();
    receive.resolve();
    (await pending).close();
  });
  it("rechecks temporary controller access at final admission without claiming task completion", async () => {
    const source = endpoint("source");
    const parent = endpoint("original-parent");
    const target = childOf(parent);
    const task = createSubagentRunRecord({
      runId: "controlled-task",
      childSessionKey: target.sessionKey,
      requesterSessionKey: source.sessionKey,
      requesterAgentId: "main",
    });
    subagentRuns.set(task.runId, task);
    const claim = claimAgentRunContext(
      task.runId,
      { sessionKey: target.sessionKey },
      { trackOwner: true, ownsContext: true },
    );
    expect(claim).toBeDefined();
    try {
      await withGate({ ...operation(source, target), access: { controllerOnly: true } }, (gate) => {
        expect(gate.ownedTask).toBe(false);
        releaseAgentRunContext(task.runId, claim);
        expect(gate.assertCurrent).toThrow("controller access changed");
      });
    } finally {
      releaseAgentRunContext(task.runId, claim);
      subagentRuns.delete(task.runId);
    }
  });

  it("only live exact owned tasks get the guidance exception", async () => {
    const source = endpoint("source", neverSend);
    const target = childOf(source, neverReceive);
    state.task = {
      runId: "task",
      requesterSessionKey: source.sessionKey,
      requesterAgentId: "main",
    };
    await withGate(operation(source, target), (gate) => {
      expect(gate.ownedTask).toBe(true);
      state.task = undefined;
      expect(gate.assertCurrent).toThrow("authority changed");
    });
    await expect(prepareSessionsSendCommunication(operation(source, target))).rejects.toThrow(
      "disabled",
    );
  });
  it.each(["entry", "replacement"] as const)(
    "survives neutral %s metadata but keeps permission revocation sticky",
    async (kind) => {
      const input = operation();
      await withGate(input, (gate) => {
        const publish = (entry: SessionEntry) =>
          changed(input, {
            storePath: "/sessions",
            facts:
              kind === "entry"
                ? {
                    kind,
                    previousSessionId: "target",
                    sessionId: "target",
                    category: null,
                    clearMembers: false,
                    communicationBinding: communicationEntryBinding(entry),
                  }
                : {
                    kind,
                    membership: [input.target.sessionKey, null, [], {}, entry.sessionId],
                    lifecycleChanged: false,
                    communicationBinding: communicationEntryBinding(entry),
                  },
          });
        publish({ ...input.target.entry!, updatedAt: 9 });
        expect(gate.assertCurrent).not.toThrow();
        publish({ ...input.target.entry!, ...neverReceive });
        expect(gate.assertCurrent).toThrow("changed");
        publish(input.target.entry!);
        expect(gate.assertCurrent).toThrow("changed");
      });
    },
  );
  it("ignores metadata notifications but fences unknown storage changes", async () => {
    const input = operation();
    await withGate(input, async (gate) => {
      changed(input);
      await gate.refresh();
      expect(gate.assertCurrent).not.toThrow();
      changed(input, { factsInvalidated: true });
      expect(gate.assertCurrent).toThrow("changed");
    });
  });

  it("refuses a replacement without current communication facts", async () => {
    const input = operation();
    await withGate(input, (gate) => {
      changed(input, {
        storePath: "/sessions",
        facts: {
          kind: "replacement",
          membership: [input.target.sessionKey, null, [], {}, "target"],
          lifecycleChanged: false,
        },
      });
      expect(gate.assertCurrent).toThrow("changed");
    });
  });
  it("worker revocation and target redirection cannot pass admission", async () => {
    const input = operation();
    const source = vi.fn();
    await withGate({ ...input, assertSourceCurrent: source }, async (gate) => {
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
    });
  });
  it("denies a missing configured target before creating it and binds only its approved creation", async () => {
    const missing = missingTarget();
    const input = operation(endpoint("source", neverSend), missing);
    await denied(input, "disabled");
    await withGate(
      {
        ...operation(endpoint("source"), missing),
        ensureTarget: async (assertCurrent) => {
          assertCurrent();
          sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
          return endpoint("target");
        },
      },
      (gate) => expect(gate.assertCurrent).not.toThrow(),
    );
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
    await withGate(input, async (gate) => {
      await expect(gate.callGateway(agentRequest(input))).rejects.toThrow("input changed");
    });
  });

  it("same-session source replies are not peer communication", async () => {
    const source = endpoint("source", { communication: { send: "never", receive: "never" } });
    await withGate(operation(source, source), () => {
      expect(state.approve).not.toHaveBeenCalled();
    });
  });
  it("always cannot override the disabled cross-agent access ceiling", async () => {
    state.config = { tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } } };
    const input = operation(undefined, endpoint("target", {}, "peer"));
    await expect(prepareSessionsSendCommunication(input)).rejects.toThrow();
    expectNoApprovalOrDelivery(input);
  });

  it("rechecks config after human approval and at final dispatch", async () => {
    const input = operation(endpoint("source", askSend));
    state.approve.mockImplementation(async () => {
      state.config = selfOnly;
    });
    await denied(input, "policy changed");
    state.config = {};
    const next = operation();
    await withGate(next, async (gate) => {
      state.config = selfOnly;
      await expect(gate.callGateway(agentRequest(next))).rejects.toThrow("policy changed");
      expect(next.callGateway).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["message", { message: "unseen" }],
    ["agentId", { agentId: "peer" }],
    ["source", { inputProvenance: { sourceSessionKey: "foreign" } }],
  ] as const)("rejects changed %s before host admission", async (_field, params) => {
    const input = operation();
    await deniedDispatch(input, params, "redirected");
  });
  it.each(["never", "sender-refusal"] as const)(
    "%s never creates empty target metadata",
    async (reason) => {
      state.config = {
        session: { communication: { send: "ask", receive: reason === "never" ? "never" : "ask" } },
      };
      const missing = missingTarget();
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
    await withGate(input, async (gate) => {
      input.message = "changed after approval";
      await expect(gate.callGateway(agentRequest(input))).rejects.toThrow("redirected");
      expect(input.callGateway).not.toHaveBeenCalled();
    });
  });
});
