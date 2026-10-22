import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import {
  activateMcpLoopbackClientGrantCapture as activateCapture,
  bindMcpLoopbackClientGrantAdmission as bindAdmission,
  deactivateMcpLoopbackClientGrantCapture as deactivateCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  registerMcpLoopbackClientGrantRevocationListener as registerRevocations,
  resolveAttachGrant,
  resolveMcpLoopbackClientGrant as resolveClient,
  revokeAttachGrant,
  revokeAttachGrantsForSession,
  revokeMcpLoopbackClientGrant as revokeClient,
  revokeMcpLoopbackClientGrantsForRuntime as revokeRuntime,
  transferMcpLoopbackClientGrant as transferClient,
} from "./mcp-grant-store.js";

const T0 = 1_000_000_000_000;
const admissions: PreparedAgentRunAdmission[] = [];
const grantParams = (token: string, captureKey: string, runtimeOwnerToken = "runtime-one") => ({
  token,
  captureKey,
  runtimeOwnerToken,
});
type ClientParams = Parameters<typeof mintMcpLoopbackClientGrant>[0];
function mintClient({
  context,
  ...params
}: Partial<Omit<ClientParams, "context">> & {
  context?: Partial<ClientParams["context"]>;
} = {}) {
  return mintMcpLoopbackClientGrant({
    context: { sessionKey: "agent:main:first", senderIsOwner: false, ...context },
    runtimeOwnerToken: "runtime-one",
    ...params,
  });
}

async function admitted(runId: string): Promise<AdmittedRunContext> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-grant-store-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

describe("mcp-grant-store", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    ["runtime-one", "runtime-two"].forEach(revokeRuntime);
  });

  afterEach(() => {
    for (const admission of admissions.splice(0)) {
      admission.close();
    }
    clearRuntimeConfigSnapshot();
  });

  it("requires a non-empty sessionKey", () => {
    expect(() => mintAttachGrant({ sessionKey: "  ", nowMs: T0 })).toThrow();
  });

  it("resolves a live grant and drops it once expired (TTL)", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", ttlMs: 1_000, nowMs: T0 });
    expect(resolveAttachGrant(g.token, T0)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 999)?.sessionKey).toBe("agent:main:x");
    expect(resolveAttachGrant(g.token, T0 + 1_000)).toBeUndefined();
    expect(resolveAttachGrant(g.token, T0 + 1_001)).toBeUndefined();
  });

  it("binds a separate agent owner only to the canonical global session", () => {
    const global = mintAttachGrant({ sessionKey: "global", agentId: " ops ", nowMs: T0 });
    const scoped = mintAttachGrant({
      sessionKey: "agent:main:telegram:1",
      agentId: "ops",
      nowMs: T0,
    });

    expect(global.agentId).toBe("ops");
    expect(scoped.agentId).toBeUndefined();
  });

  it("revokes by token", () => {
    const g = mintAttachGrant({ sessionKey: "agent:main:x", nowMs: T0 });
    expect(revokeAttachGrant(g.token)).toBe(true);
    expect(resolveAttachGrant(g.token, T0)).toBeUndefined();
    expect(revokeAttachGrant(g.token)).toBe(false);
  });

  it("revokes every attach grant for one session", () => {
    const first = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const second = mintAttachGrant({ sessionKey: "agent:main:first", nowMs: T0 });
    const other = mintAttachGrant({ sessionKey: "agent:main:other", nowMs: T0 });

    expect(revokeAttachGrantsForSession(" agent:main:first ")).toBe(2);
    expect(resolveAttachGrant(first.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(second.token, T0)).toBeUndefined();
    expect(resolveAttachGrant(other.token, T0)?.sessionKey).toBe("agent:main:other");
  });

  it("clamps TTL: default for non-positive, ceiling at 12h", () => {
    const def = mintAttachGrant({ sessionKey: "s", nowMs: T0 });
    expect(def.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const zero = mintAttachGrant({ sessionKey: "s", ttlMs: 0, nowMs: T0 });
    expect(zero.expiresAtMs).toBe(T0 + 60 * 60 * 1000);
    const huge = mintAttachGrant({ sessionKey: "s", ttlMs: 999 * 60 * 60 * 1000, nowMs: T0 });
    expect(huge.expiresAtMs).toBe(T0 + 12 * 60 * 60 * 1000);
  });

  it("binds an immutable Gateway-selected context to a loopback client grant", async () => {
    const admittedRunContext = await admitted("run-immutable-context");
    const context = {
      sessionKey: " agent:main:telegram:group:1 ",
      sessionId: "session-1",
      messageProvider: "telegram",
      clientCaps: ["tool-events"],
      pinnedWidgetAuthoring: true,
      currentChannelId: "telegram:-1001",
      currentThreadTs: "42",
      currentMessageId: "message-1",
      currentInboundAudio: true,
      accountId: "account-1",
      inboundEventKind: "room_event" as const,
      sourceReplyDeliveryMode: "message_tool_only" as const,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
      taskSuggestionDeliveryMode: "gateway" as const,
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
    };
    const grant = mintMcpLoopbackClientGrant({
      context,
      admittedRunContext,
      runtimeOwnerToken: "runtime-one",
    });
    expect(activateCapture(grantParams(grant.token, "capture-one"))).toBeTruthy();

    context.clientCaps.push("caller-mutation");
    context.pinnedWidgetAuthoring = false;
    context.sourceReplyOnly = false;
    context.toolsAllow.push("exec");
    grant.context.clientCaps?.push("return-value-mutation");
    grant.context.pinnedWidgetAuthoring = false;
    grant.context.sourceReplyOnly = false;
    grant.context.toolsAllow?.push("write");

    const resolved = resolveClient(grantParams(grant.token, "capture-one"));
    expect(resolved?.admittedRunContext).toBe(admittedRunContext);
    expect(grant.context).not.toHaveProperty("admittedRunContext");
    expect(resolved?.context).toEqual({
      ...context,
      sessionKey: "agent:main:telegram:group:1",
      clientCaps: ["tool-events"],
      pinnedWidgetAuthoring: true,
      sourceReplyOnly: true,
      toolsAllow: ["message"],
    });
  });

  it("admits only the active capture on the grant's Gateway runtime", async () => {
    const grant = mintClient({ admittedRunContext: await admitted("run-active-capture") });
    const resolve = (runtimeOwnerToken: string, captureKey: string) =>
      resolveClient(grantParams(grant.token, captureKey, runtimeOwnerToken));
    const activate = (captureKey: string, runtimeOwnerToken = "runtime-one") =>
      activateCapture(grantParams(grant.token, captureKey, runtimeOwnerToken));
    const deactivate = (captureKey: string) =>
      deactivateCapture(grantParams(grant.token, captureKey));

    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(activate("capture-a", "runtime-other")).toBe(false);
    expect(activate("capture-a")).toBeTruthy();
    expect(resolve("runtime-other", "capture-a")).toBeUndefined();
    expect(resolve("runtime-one", "capture-forged")).toBeUndefined();
    const first = resolve("runtime-one", "capture-a");
    expect(first?.captureKey).toBe("capture-a");
    expect(first?.isCurrent()).toBe(true);

    expect(activate("capture-b")).toBeTruthy();
    expect(resolve("runtime-one", "capture-a")).toBeUndefined();
    expect(first?.isCurrent()).toBe(false);
    expect(deactivate("capture-a")).toBe(false);
    const second = resolve("runtime-one", "capture-b");
    expect(second?.captureKey).toBe("capture-b");
    expect(second?.isCurrent()).toBe(true);
    expect(deactivate("capture-b")).toBe(true);
    expect(resolve("runtime-one", "capture-b")).toBeUndefined();
    expect(second?.isCurrent()).toBe(false);
  });

  it("replaces native authority only from the current observed capture", async () => {
    const grant = mintClient({
      context: { nativeCronCreatorToolAllowlist: ["read", "exec"] },
      admittedRunContext: await admitted("run-native-authority"),
    });
    const params = grantParams(grant.token, "capture-native");
    const capture = activateCapture(params);
    if (!capture) {
      throw new Error("expected an active native capture");
    }
    const pending = resolveClient(params);
    expect(pending?.context.nativeCronCreatorToolAllowlist).toBeNull();
    const observed = ["read"];
    expect(capture.captureNativeToolAuthority(observed)).toBe(true);
    observed.push("exec");
    expect(pending?.isCurrent()).toBe(false);
    expect(resolveClient(params)?.context.nativeCronCreatorToolAllowlist).toEqual(["read"]);

    expect(capture.captureNativeToolAuthority([])).toBe(true);
    expect(resolveClient(params)?.context.nativeCronCreatorToolAllowlist).toEqual([]);
    expect(activateCapture(params)).toBeTruthy();
    expect(resolveClient(params)?.context.nativeCronCreatorToolAllowlist).toBeNull();
    expect(capture.captureNativeToolAuthority(["exec"])).toBe(false);
  });

  it.each([
    "rebind",
    "close",
    "source-abort",
    "caller-revocation",
    "capture-abort",
    "revoke-during-assertion",
  ] as const)("rejects a retained native capture after %s", async (invalidation) => {
    const admittedRunContext = await admitted("run-stale-native");
    const sourceController = new AbortController();
    const captureController = new AbortController();
    let callerCurrent = true;
    let revokeDuringAssertion = false;
    const grant = mintClient({
      context: { nativeCronCreatorToolAllowlist: [] },
      admittedRunContext,
      abortSignal: sourceController.signal,
      assertCurrent: () => {
        if (!callerCurrent) {
          throw new Error("caller revoked");
        }
        if (revokeDuringAssertion) {
          revokeClient(grant.token);
        }
      },
    });
    const params = grantParams(grant.token, "capture-stale-native");
    const capture = activateCapture({
      ...params,
      assertCurrent: () => captureController.signal.throwIfAborted(),
    });
    if (!capture) {
      throw new Error("expected an active native capture");
    }
    expect(capture.captureNativeToolAuthority(["read"])).toBe(true);
    const retained = resolveClient(params);
    expect(retained?.isCurrent()).toBe(true);
    const invalidate = {
      rebind: () => bindAdmission({ ...params, admittedRunContext }),
      close: () => admissions.at(-1)?.close(),
      "source-abort": () => sourceController.abort(),
      "caller-revocation": () => {
        callerCurrent = false;
      },
      "capture-abort": () => captureController.abort(),
      "revoke-during-assertion": () => {
        revokeDuringAssertion = true;
      },
    };
    invalidate[invalidation]();
    expect(retained?.isCurrent()).toBe(false);
    expect(capture.captureNativeToolAuthority(["exec"])).toBe(false);
    expect(capture.captureNativeToolAuthority(null)).toBe(false);
    expect(resolveClient(params)?.context.nativeCronCreatorToolAllowlist).toEqual(
      invalidation === "rebind" ? ["read"] : undefined,
    );
  });

  it("binds one exact late admission and rejects replacement authority", async () => {
    const grant = mintClient();
    const bind = async () =>
      bindAdmission({
        token: grant.token,
        runtimeOwnerToken: "runtime-one",
        admittedRunContext: await admitted("run-late-binding"),
      });
    expect(await bind()).toBe(true);
    expect(await bind()).toBe(false);
  });

  it("transfers fresh turn authority onto a process-stable bearer", async () => {
    const firstAdmission = await admitted("run-first-turn");
    const nextAdmission = await admitted("run-next-turn");
    const firstController = new AbortController();
    const nextController = new AbortController();
    const skillLibraryAuthoring: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget: "personal",
      multipleProfiles: true,
      bind: () => {},
      invoke: async () => {
        throw new Error("unused");
      },
    };
    const stable = mintClient({
      context: { runId: "run-first-turn" },
      admittedRunContext: firstAdmission,
      abortSignal: firstController.signal,
    });
    const next = mintClient({
      context: { sessionKey: "agent:main:next", runId: "run-next-turn", senderIsOwner: true },
      admittedRunContext: nextAdmission,
      abortSignal: nextController.signal,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    expect(activateCapture(grantParams(stable.token, "stale-capture"))).toBeTruthy();
    const first = resolveClient(grantParams(stable.token, "stale-capture"));
    expect(first?.isCurrent()).toBe(true);
    // A warm child's exact revoked bearer must be restorable for the next turn.
    firstController.abort();
    expect(revokeClient(stable.token)).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    const revocations: Array<{ token: string; runtimeOwnerToken: string }> = [];
    const unregister = registerRevocations((event) => {
      revocations.push(event);
    });
    const transfer = (runtimeOwnerToken: string) =>
      transferClient({
        sourceToken: next.token,
        targetToken: stable.token,
        runtimeOwnerToken,
      });

    try {
      expect(transfer("runtime-two")).toBe(false);
      expect(transfer("runtime-one")).toBe(true);
    } finally {
      unregister();
    }

    expect(resolveClient(grantParams(stable.token, "stale-capture"))).toBeUndefined();
    expect(activateCapture(grantParams(stable.token, "next-capture"))).toBeTruthy();
    const transferred = resolveClient(grantParams(stable.token, "next-capture"));
    expect(transferred).toMatchObject({
      context: {
        sessionKey: "agent:main:next",
        runId: "run-next-turn",
        senderIsOwner: true,
      },
      admittedRunContext: nextAdmission,
      skillLibraryAuthoring,
      toolAuth: {
        agentDir: "/tmp/next-agent",
        store: { version: 1, profiles: {} },
      },
    });
    expect(transferred?.skillLibraryAuthoring).toBe(skillLibraryAuthoring);
    expect(transferred?.isCurrent()).toBe(true);
    expect(first?.isCurrent()).toBe(false);
    expect(activateCapture(grantParams(next.token, "forged-source-capture"))).toBe(false);
    expect(revocations).toEqual([
      { token: stable.token, runtimeOwnerToken: "runtime-one" },
      { token: next.token, runtimeOwnerToken: "runtime-one" },
    ]);
    nextController.abort();
    expect(transferred?.isCurrent()).toBe(false);
    expect(resolveClient(grantParams(stable.token, "next-capture"))).toBeUndefined();
  });

  it("notifies revocation listeners for single and runtime-wide cleanup", () => {
    const successor = mintClient({
      context: { sessionKey: "agent:main:successor" },
      runtimeOwnerToken: "runtime-two",
    });
    const events: Array<{ token: string; runtimeOwnerToken: string }> = [];
    const unregister = registerRevocations((event) => {
      events.push(event);
    });
    try {
      const first = mintClient();
      const second = mintClient({ context: { sessionKey: "agent:main:second" } });

      expect(revokeClient(first.token)).toBe(true);
      expect(revokeClient(first.token)).toBe(false);
      expect(revokeRuntime("runtime-one")).toBe(1);
      expect(events).toEqual([
        { token: first.token, runtimeOwnerToken: "runtime-one" },
        { token: second.token, runtimeOwnerToken: "runtime-one" },
      ]);
    } finally {
      unregister();
    }
    expect(revokeClient(successor.token)).toBe(true);

    const afterUnregister = mintClient({ context: { sessionKey: "agent:main:later" } });
    expect(revokeClient(afterUnregister.token)).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("requires a session key for loopback client grants", () => {
    expect(() => mintClient({ context: { sessionKey: "  " } })).toThrow(/sessionKey is required/);
    expect(() => mintClient({ runtimeOwnerToken: "  " })).toThrow(/runtimeOwnerToken is required/);
  });
});
