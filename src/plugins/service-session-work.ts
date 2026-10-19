import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { captureAmbientGatewayOperatorAuthority } from "../gateway/operator-invocation-authority.js";
import type { OperatorRunRecoverySnapshot } from "../gateway/operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "../gateway/operator-run-recovery.js";
import { runWithOperatorToolGatewayAuthority } from "../gateway/operator-tool-gateway-authority.js";
import { runWithPluginSessionWorkAuthority } from "../gateway/plugin-session-work-authority.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { resolveInProcessGatewayDispatch } from "../gateway/server-plugin-in-process-authority.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import {
  prepareGatewaySessionAccessAuthority,
  SessionAccessPreparationPendingError,
} from "../gateway/session-access-authority.js";
import { requireSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createCorePluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type {
  PluginServiceSessionWorkContextV1,
  PluginServiceSessionWorkV1,
} from "./service-session-work.types.js";

type AcceptedWork = {
  target: PluginServiceSessionWorkContextV1["target"];
  toolName: string;
  tools: string[];
  snapshot?: OperatorRunRecoverySnapshot;
};
const retentionMs = 7 * 24 * 60 * 60_000;

/** Host custody and current policy, separate from feature-owned jobs, wakes and results. */
export function createPluginServiceSessionWork(params: {
  pluginId: string;
  serviceId: string;
  registry: PluginRegistry;
  lease: PluginRuntimeCapabilityLease;
  signal: AbortSignal;
  isStopping: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}): PluginServiceSessionWorkV1 {
  const assertService = () => {
    params.lease.assertActive("session work");
    params.signal.throwIfAborted();
    if (params.isStopping()) {
      throw new Error("Plugin service session work is stopping");
    }
  };
  const namespace = createHash("sha256")
    .update(JSON.stringify([params.pluginId, params.serviceId]))
    .digest("hex");
  const store = (assertCurrent = assertService) =>
    createCorePluginStateKeyedStoreV2<AcceptedWork>(
      {
        ownerId: "core:plugin-session-work",
        namespace,
        maxEntries: 4096,
        overflowPolicy: "reject-new",
      },
      { assertCurrent },
    );
  const context = () => {
    assertService();
    const current = params.resolveGatewayContext?.();
    if (!current) {
      throw new Error("Session work requires its current Gateway");
    }
    return current;
  };
  const validateId = (id: string) => {
    if (!id || id.length > 256) {
      throw new Error("Session work requires a bounded logical operation ID");
    }
  };
  async function withInvocation<T>(
    input: Omit<Parameters<PluginServiceSessionWorkV1["admit"]>[0], "id">,
    work: (current: PluginServiceSessionWorkContextV1, record: AcceptedWork) => Promise<T>,
  ): Promise<T> {
    const owner = context();
    const scope = getPluginRuntimeGatewayRequestScope();
    if (
      scope?.pluginId !== params.pluginId ||
      !params.registry.tools.some(
        (entry) =>
          entry.pluginId === params.pluginId &&
          (entry.declaredNames?.has(input.toolName) ?? entry.names.includes(input.toolName)),
      )
    ) {
      throw new Error("Session work requires its registered tool owner");
    }
    const caller = getGatewayToolCallerIdentity();
    const assertCaller = captureGatewayToolCallerAssertion();
    const captured = await captureAmbientGatewayOperatorAuthority({
      missingBindingError: () => new Error("Session work requires its original operator source"),
      retainInherited: true,
    });
    const active = new AbortController();
    const signal = AbortSignal.any([
      params.signal,
      active.signal,
      ...(scope?.signal ? [scope.signal] : []),
      ...(captured.authority?.signal ? [captured.authority.signal] : []),
    ]);
    let releaseSession: (() => void) | undefined;
    let assertSession: (() => void) | undefined;
    try {
      const assertCurrent = () => {
        signal.throwIfAborted();
        assertService();
        if (context() !== owner) {
          throw new Error("Session work Gateway changed");
        }
        assertCaller?.();
        captured.assertInvocationCurrent?.();
        captured.authority?.assertCurrent();
        assertSession?.();
      };
      assertCurrent();
      const resolved = resolveInProcessGatewayDispatch("tools.invoke", input, {
        // Preserve a real operator request; an admitted agent still resolves to
        // its synthetic client with the original executable-tool ceiling.
        pluginRuntimeOwnerId: params.pluginId,
        resolveGatewayContext: params.resolveGatewayContext,
      });
      const tools = [...new Set([input.toolName, ...(input.delegatedTools ?? [])])];
      if (tools.length > 32 || tools.some((name) => !name || name.length > 256)) {
        throw new Error("Session work tool request exceeds its bound");
      }
      let target: AcceptedWork["target"] | undefined;
      // Capture only requested effects that the *original live source* allows.
      // Reauthorization intersects this restriction with current policy on every wake.
      for (const name of tools) {
        if (caller?.operationalRunInstance && !caller.assertToolAllowed) {
          throw new Error("Session work requires the original executable tool policy");
        }
        // A standalone operator tool has routing context, not an admitted agent
        // run. Its authenticated request still passes the session gate below.
        caller?.assertToolAllowed?.(name);
        const prepared = await prepareGatewaySessionAccessAuthority({
          policy: { mode: "write", requiredTool: name },
          methodOwner: { kind: "plugin", pluginId: params.pluginId },
          pluginRegistry: params.registry,
          requestParams: input,
          client: resolved.operatorSourceClient,
          context: owner,
          ownSessionOnly: false,
          assertInvocationCurrent: assertCurrent,
        });
        try {
          assertCurrent();
          prepared.authority.assertCurrent();
          if (name === input.toolName) {
            target = prepared.authority.target;
            const retained = prepared.authority.retain();
            releaseSession = retained.release;
            assertSession = retained.assertCurrent;
          }
        } finally {
          prepared.authority.release();
        }
      }
      if (!target) {
        throw new Error("Session work target was not admitted");
      }
      assertCurrent();
      const record: AcceptedWork = {
        target: Object.freeze({ ...target }),
        toolName: input.toolName,
        tools,
        ...(captured.authority?.recoverySnapshot
          ? { snapshot: captured.authority.recoverySnapshot }
          : {}),
      };
      const value = await work(
        Object.freeze({ target: record.target, signal, assertCurrent }),
        record,
      );
      assertCurrent();
      return value;
    } finally {
      active.abort(new Error("Current session work borrow closed"));
      releaseSession?.();
      captured.release?.();
    }
  }
  return {
    version: 1,
    withCurrent: (input, work) => withInvocation(input, (current) => work(current)),
    async admit(input) {
      validateId(input.id);
      return withInvocation(input, async ({ assertCurrent }, record) => {
        const durable = store(assertCurrent);
        if (!(await durable.registerIfAbsent(input.id, record, { ttlMs: retentionMs }))) {
          const existing = await durable.lookup(input.id);
          assertCurrent();
          if (
            !existing ||
            !isDeepStrictEqual(existing.target, record.target) ||
            existing.toolName !== record.toolName ||
            !isDeepStrictEqual(existing.tools, record.tools) ||
            !isDeepStrictEqual(existing.snapshot, record.snapshot)
          ) {
            throw new Error("Session work ID belongs to a different accepted operation");
          }
          return { target: record.target, recoverable: existing.snapshot !== undefined };
        }
        return { target: record.target, recoverable: record.snapshot !== undefined };
      });
    },
    async run(id, work) {
      validateId(id);
      const owner = context();
      const assertOwner = () => {
        assertService();
        if (context() !== owner) {
          throw new Error("Session work Gateway changed");
        }
      };
      const durable = store(assertOwner);
      const accepted = await durable.lookup(id);
      assertOwner();
      if (!accepted?.snapshot) {
        return {
          status: "unavailable",
          reason: "Original source has no restart-recoverable authority",
        };
      }
      const projection = requireSessionRowProjection(owner);
      const assertTarget = () => {
        assertOwner();
        if (requireSessionRowProjection(owner) !== projection) {
          throw new Error("Session work projection changed");
        }
        const state = projection.sharingTargetState({
          agentId: accepted.target.agentId,
          key: accepted.target.sessionKey,
        });
        if (state.status === "pending") {
          throw new SessionAccessPreparationPendingError();
        }
        const current = state.status === "ready" ? state.target : undefined;
        if (
          !current ||
          current.entry.sessionId !== accepted.target.sessionId ||
          current.entry.lifecycleRevision !== accepted.target.lifecycleRevision
        ) {
          throw new Error("Session work conversation is unavailable or changed");
        }
      };
      let restored: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
      let session: Awaited<ReturnType<typeof prepareGatewaySessionAccessAuthority>> | undefined;
      const active = new AbortController();
      let started = false;
      let assertBorrow = () => {
        assertTarget();
        active.signal.throwIfAborted();
      };
      try {
        restored = await restoreGatewayOperatorSource({
          snapshot: accepted.snapshot,
          target: accepted.target,
          context: owner,
          assertCurrent: assertOwner,
          prepareCurrent: async () => {
            const current = await durable.lookup(id);
            assertOwner();
            await projection.prepareMembership();
            assertTarget();
            if (!isDeepStrictEqual(current, accepted)) {
              throw new Error("Accepted source no longer owns this work");
            }
          },
        });
        const authority = restored.authority;
        const signal = AbortSignal.any([
          params.signal,
          active.signal,
          ...(authority.signal ? [authority.signal] : []),
        ]);
        const assertCurrent = () => {
          try {
            signal.throwIfAborted();
            authority.assertCurrent();
            assertBorrow();
          } catch (error) {
            // A transient preparation failure closes this borrow. Catch handlers
            // cannot regain write authority when facts become ready a moment later.
            if (error instanceof SessionAccessPreparationPendingError) {
              active.abort(error);
            }
            throw error;
          }
        };
        const current: PluginServiceSessionWorkContextV1 = Object.freeze({
          target: Object.freeze({ ...accepted.target }),
          signal,
          assertCurrent,
        });
        const execution = {
          ...current,
          pluginId: params.pluginId,
          context: owner,
          assertToolAllowed: (name: string) => {
            assertCurrent();
            if (!accepted.tools.includes(name)) {
              throw new Error("Tool was not admitted by this operation's original source");
            }
          },
        };
        const source = {
          authenticatedUserProfile: restored.authenticatedUserProfile,
          scopes: authority.scopes,
          operatorRoleActor: { kind: "operator" as const, profileId: authority.profileId },
          operatorRunAuthority: authority,
          signal,
          assertCurrent,
        };
        session = await runWithPluginSessionWorkAuthority(execution, () =>
          prepareGatewaySessionAccessAuthority({
            policy: { mode: "write", requiredTool: accepted.toolName },
            methodOwner: { kind: "plugin", pluginId: params.pluginId },
            pluginRegistry: params.registry,
            requestParams: accepted.target,
            client: createSyntheticPluginRuntimeClient({
              ...source,
              scopes: [...source.scopes],
              pluginRuntimeOwnerId: params.pluginId,
            }),
            context: owner,
            ownSessionOnly: false,
            assertInvocationCurrent: () => {
              assertTarget();
              authority.assertCurrent();
            },
          }),
        );
        const retained = session.authority.retain();
        session.authority.release();
        session = undefined;
        assertBorrow = () => {
          assertTarget();
          active.signal.throwIfAborted();
          retained.assertCurrent();
        };
        try {
          assertCurrent();
          // Only this borrowed host scope carries the reauthorized source to normal
          // Gateway/model dispatch. No agent run or tool caller is reconstructed.
          started = true;
          const value = await runWithPluginSessionWorkAuthority(execution, () =>
            runWithOperatorToolGatewayAuthority(source, () => work(current)),
          );
          assertCurrent();
          return { status: "completed", value };
        } finally {
          retained.release();
        }
      } catch (error) {
        if (
          error instanceof SessionAccessPreparationPendingError ||
          active.signal.reason instanceof SessionAccessPreparationPendingError
        ) {
          assertOwner();
          return {
            status: "unavailable",
            reason: "Session access is refreshing",
            retryAfterMs: 5000,
          };
        }
        if (started) {
          throw error;
        }
        assertOwner();
        return {
          status: "unavailable",
          reason: "Original source or current session policy no longer authorizes this operation",
        };
      } finally {
        active.abort(new Error("Session work borrow closed"));
        session?.authority.release();
        restored?.release();
      }
    },
  };
}
