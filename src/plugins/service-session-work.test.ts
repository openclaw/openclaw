import { beforeEach, expect, it, vi } from "vitest";
import { readPluginSessionWorkAuthority } from "../gateway/plugin-session-work-authority.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { SessionAccessPreparationPendingError } from "../gateway/session-access-authority.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginServiceSessionWork } from "./service-session-work.js";

const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  target: {
    agentId: "main",
    sessionKey: "agent:main:research",
    sessionId: "session",
    lifecycleRevision: "1",
  },
  pending: false,
  restoreError: undefined as Error | undefined,
  readError: undefined as Error | undefined,
  allowTool: true,
  recoverable: true,
  release: vi.fn(),
  assertCurrent: vi.fn(),
  prepare: vi.fn(),
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../agents/tools/gateway-caller-context.js", () => ({
  captureGatewayToolCallerAssertion: () => state.assertCurrent,
  getGatewayToolCallerIdentity: () => ({
    agentId: "main",
    sessionKey: "agent:main:research",
    assertToolAllowed: () => {
      if (!state.allowTool) {
        throw new Error("tool denied");
      }
    },
  }),
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../gateway/operator-invocation-authority.js", () => ({
  captureAmbientGatewayOperatorAuthority: async () => ({
    authority: {
      assertCurrent: state.assertCurrent,
      ...(state.recoverable ? { recoverySnapshot: { source: "fixture" } } : {}),
    },
    release: state.release,
  }),
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../gateway/operator-run-recovery.js", () => ({
  restoreGatewayOperatorSource: async (params: { prepareCurrent: () => Promise<void> }) => {
    if (state.restoreError) {
      throw state.restoreError;
    }
    await params.prepareCurrent();
    return {
      authority: {
        assertCurrent: state.assertCurrent,
        scopes: ["operator.write"],
        profileId: "alice",
      },
      authenticatedUserProfile: { profileId: "alice" },
      release: state.release,
    };
  },
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../gateway/server-plugin-in-process-authority.js", () => ({
  resolveInProcessGatewayDispatch: () => ({ operatorSourceClient: {} }),
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../gateway/session-access-authority.js", async (original) => {
  const actual = await original<typeof import("../gateway/session-access-authority.js")>();
  return {
    ...actual,
    prepareGatewaySessionAccessAuthority: async (params: unknown) => {
      state.prepare(params);
      const authority = {
        target: { ...state.target },
        assertCurrent: state.assertCurrent,
        retain: () => ({ assertCurrent: state.assertCurrent, release: state.release }),
        release: state.release,
      };
      return { authority };
    },
  };
});
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../gateway/session-row-projection-access.js", () => ({
  requireSessionRowProjection: () => projection,
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("../plugin-state/plugin-state-store.js", () => ({
  createCorePluginStateKeyedStoreV2: (_options: unknown, hooks: { assertCurrent: () => void }) => ({
    registerIfAbsent: async (id: string, value: unknown) => {
      hooks.assertCurrent();
      if (state.records.has(id)) {
        return false;
      }
      state.records.set(id, value);
      return true;
    },
    lookup: async (id: string) => {
      hooks.assertCurrent();
      if (state.readError) {
        throw state.readError;
      }
      return state.records.get(id);
    },
  }),
}));
// mock-isolation: keep durable storage and original operator fixtures local to this host-boundary test.
vi.mock("./runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ pluginId: "research" }),
}));
const projection = {
  prepareMembership: async () => {},
  sharingTargetState: () =>
    state.pending
      ? { status: "pending" }
      : {
          status: "ready",
          target: {
            entry: {
              sessionId: state.target.sessionId,
              lifecycleRevision: state.target.lifecycleRevision,
            },
          },
        },
};
const context = {} as GatewayRequestContext;
function fixture() {
  const registry = createEmptyPluginRegistry();
  registry.tools.push({
    pluginId: "research",
    names: ["research"],
  } as (typeof registry.tools)[number]);
  const signal = new AbortController();
  const lease = createPluginRuntimeCapabilityLease("research");
  const service = createPluginServiceSessionWork({
    pluginId: "research",
    serviceId: "research",
    registry,
    lease,
    signal: signal.signal,
    isStopping: () => false,
    resolveGatewayContext: () => context,
  });
  return { service, lease, signal };
}
const input = {
  id: "job",
  agentId: "main",
  sessionKey: "agent:main:research",
  toolName: "research",
  delegatedTools: ["web_search"],
};
beforeEach(() => {
  state.records.clear();
  state.pending = false;
  state.restoreError = undefined;
  state.readError = undefined;
  state.allowTool = true;
  state.recoverable = true;
  state.target.lifecycleRevision = "1";
  vi.clearAllMocks();
});
it.each([
  { agentId: "other", sessionKey: "agent:main:research" },
  { agentId: "main", sessionKey: "agent:main:other" },
])("rejects admission outside the live caller's conversation: %j", async (target) => {
  const { service } = fixture();
  await expect(service.admit({ ...input, ...target })).rejects.toThrow("own conversation");
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.records.size).toBe(0);
});

it("admits and reauthorizes an exact operation with its original tool ceiling", async () => {
  const { service } = fixture();
  await expect(service.admit(input)).resolves.toEqual({ target: state.target, recoverable: true });
  await expect(service.admit(input)).resolves.toEqual({ target: state.target, recoverable: true });
  let escaped: ReturnType<typeof readPluginSessionWorkAuthority>;
  await expect(
    service.run("job", async (borrow) => {
      escaped = readPluginSessionWorkAuthority();
      expect(escaped?.target).toEqual(state.target);
      escaped?.assertToolAllowed("web_search");
      expect(() => escaped?.assertToolAllowed("exec")).toThrow("not admitted");
      borrow.assertCurrent();
      return "completed";
    }),
  ).resolves.toEqual({ status: "completed", value: "completed" });
  expect(readPluginSessionWorkAuthority()).toBeUndefined();
  expect(() => escaped?.assertCurrent()).toThrow("borrow closed");
  expect(state.release).toHaveBeenCalled();
});
it("rejects reused IDs whose requested effects differ", async () => {
  const { service } = fixture();
  await service.admit(input);
  await expect(service.admit({ ...input, delegatedTools: ["exec"] })).rejects.toThrow(
    "different accepted operation",
  );
});
it("refuses original tool policy denial before persisting", async () => {
  const { service } = fixture();
  state.allowTool = false;
  await expect(service.admit(input)).rejects.toThrow("tool denied");
  expect(state.records.size).toBe(0);
});
it("does not enter work without a recoverable original source", async () => {
  const { service } = fixture();
  state.recoverable = false;
  await service.admit(input);
  const work = vi.fn();
  await expect(service.run("job", work)).resolves.toMatchObject({ status: "unavailable" });
  expect(work).not.toHaveBeenCalled();
});
it("refuses a replaced conversation without entering work", async () => {
  const { service } = fixture();
  await service.admit(input);
  state.target.lifecycleRevision = "2";
  const work = vi.fn();
  await expect(service.run("job", work)).resolves.toMatchObject({ status: "unavailable" });
  expect(work).not.toHaveBeenCalled();
});
it("gives a retry hint only before the callback is entered", async () => {
  const { service } = fixture();
  await service.admit(input);
  state.pending = true;
  const work = vi.fn();
  await expect(service.run("job", work)).resolves.toMatchObject({
    status: "unavailable",
    retryAfterMs: 5000,
  });
  expect(work).not.toHaveBeenCalled();
});
it("does not advertise replay after completed work encounters a refresh", async () => {
  const { service } = fixture();
  await service.admit(input);
  const work = vi.fn(async () => {
    state.pending = true;
    return "paid effect";
  });
  await expect(service.run("job", work)).rejects.toBeInstanceOf(
    SessionAccessPreparationPendingError,
  );
  expect(work).toHaveBeenCalledTimes(1);
});
it("keeps a refresh-closed borrow revoked even after membership becomes ready", async () => {
  const { service } = fixture();
  await service.admit(input);
  await expect(
    service.run("job", async (borrow) => {
      state.pending = true;
      expect(() => borrow.assertCurrent()).toThrow();
      state.pending = false;
      expect(() => borrow.assertCurrent()).toThrow();
    }),
  ).rejects.toBeInstanceOf(SessionAccessPreparationPendingError);
});
it("surfaces unexpected restore and storage failures instead of policy denial", async () => {
  const { service } = fixture();
  await service.admit(input);
  const error = new Error("temporary storage failure");
  state.restoreError = error;
  await expect(service.run("job", vi.fn())).rejects.toBe(error);
  state.restoreError = undefined;
  state.readError = error;
  await expect(service.run("job", vi.fn())).rejects.toBe(error);
});
it("reports known original-source revocation without entering work", async () => {
  const { service } = fixture();
  await service.admit(input);
  state.restoreError = new GatewayOperatorRecoveryAuthorizationError();
  const work = vi.fn();
  await expect(service.run("job", work)).resolves.toMatchObject({ status: "unavailable" });
  expect(work).not.toHaveBeenCalled();
});
it("rejects revoked service capabilities", async () => {
  const { service, lease } = fixture();
  await service.admit(input);
  lease.revoke();
  await expect(service.run("job", vi.fn())).rejects.toThrow("no longer active");
});
