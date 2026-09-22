import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
} from "../../gateway/server-methods/types.js";
import {
  onInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventMetadata,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry, addTestHook } from "../../plugins/hooks.test-fixtures.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from "../../plugins/types.js";
import {
  prepareSystemAgentRunAdmission,
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { runBeforeToolCallHook } from "../agent-tools.before-tool-call.policy.js";
import {
  bindAdmittedGatewayOwnerObservation,
  captureGatewayToolCallerAssertion,
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  observeGatewayToolCallerOwner,
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const admissions: PreparedAgentRunAdmission[] = [];
beforeEach(() => {
  resetGlobalHookRunner();
  resetDiagnosticEventsForTest();
});
afterEach(async () => {
  for (const a of admissions.splice(0)) {
    a.close();
  }
  await waitForDiagnosticEventsDrained();
  resetGlobalHookRunner();
  resetDiagnosticEventsForTest();
});
async function fixture(runId = "native-observer-run") {
  const admission = prepareSystemAgentRunAdmission({}, runId, "test", "native-observation-test");
  admissions.push(admission);
  const admitted = await admission.admit("embedded");
  // SAFETY: Only resolver identity and a nonempty context are used by this focused fixture.
  const native = {} as GatewayRequestContext;
  const owner = vi.fn<GatewayContextResolver>(() => native);
  bindGatewayContextResolver(admitted, owner);
  bindAdmittedGatewayOwnerObservation(admitted, owner);
  const context = { agentId: "test", sessionKey: "agent:test:private-canary", runId };
  const identity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    ...context,
  });
  return { admission, admitted, owner, context, identity };
}

describe("native before-tool owner observation", () => {
  it("retains delegated tool restrictions without treating an owner match as authority", async () => {
    const f = await fixture();
    const outer = vi.fn((name: string) => {
      if (name === "exec") {
        throw new Error("outer exec denied");
      }
    });
    const inner = vi.fn((name: string) => {
      if (name === "process") {
        throw new Error("inner process denied");
      }
    });
    await withGatewayToolCallerIdentity(f.identity, () =>
      withGatewayToolCallerIdentity(
        { agentId: "wrapper", sessionKey: "wrapper", assertToolAllowed: outer },
        () =>
          withGatewayToolCallerIdentity(
            { agentId: "wrapper", sessionKey: "wrapper", assertToolAllowed: inner },
            () => {
              expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
              expect(outer).not.toHaveBeenCalled();
              expect(inner).not.toHaveBeenCalled();
              const assertToolAllowed = getGatewayToolCallerIdentity()?.assertToolAllowed;
              if (!assertToolAllowed) {
                throw new Error("missing composed tool policy");
              }
              expect(() => assertToolAllowed("exec")).toThrow("outer exec denied");
              expect(() => assertToolAllowed("process")).toThrow("inner process denied");
              expect(() => assertToolAllowed("read")).not.toThrow();
              const calls = [outer.mock.calls.length, inner.mock.calls.length];
              expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
              expect([outer.mock.calls.length, inner.mock.calls.length]).toEqual(calls);
              f.admission.close();
              expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
            },
          ),
      ),
    );
  });

  it("preserves composed Cron fences without turning observation into authority", async () => {
    const f = await fixture();
    const sourceCheck = vi.fn(() => true);
    const wrapperCheck = vi.fn(() => true);
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: f.admitted,
      ...f.context,
      cronAuthorityCheck: sourceCheck,
    });
    await withGatewayToolCallerIdentity(identity, async () => {
      await withGatewayToolCallerIdentity(
        { agentId: "wrapper", sessionKey: "wrapper", cronAuthorityCheck: wrapperCheck },
        async () => {
          expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
          expect(sourceCheck).not.toHaveBeenCalled();
          expect(wrapperCheck).not.toHaveBeenCalled();
          const assertCaller = captureGatewayToolCallerAssertion();
          if (!assertCaller) {
            throw new Error("missing caller authority");
          }
          expect(() => assertCaller("cron.list")).not.toThrow();
          expect(sourceCheck).toHaveBeenCalledOnce();
          expect(wrapperCheck).toHaveBeenCalledOnce();
          sourceCheck.mockReturnValue(false);
          expect(() => assertCaller("cron.list")).toThrow("Automation caller authority");
          expect(() => assertCaller("gateway.status")).not.toThrow();
          expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
          sourceCheck.mockReturnValue(true);
          wrapperCheck.mockReturnValue(false);
          expect(() => assertCaller("cron.list")).toThrow("Automation caller authority");
          f.admission.close();
          expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
          expect(() => assertCaller("gateway.status")).toThrow("caller authority");
        },
      );
    });
  });

  it("retains the native Cron issuer only within its admitted owner", async () => {
    const a = await fixture("native-issuer-a");
    const b = await fixture("native-issuer-b");
    const nativeIssuer = vi.fn(() => {
      throw new Error("observation must not mint authority");
    });
    const wrapperIssuer = vi.fn(() => {
      throw new Error("wrapper must not replace the native issuer");
    });
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: a.admitted,
      ...a.context,
      mintCronRequesterGrant: nativeIssuer,
    });
    await withGatewayToolCallerIdentity(identity, async () => {
      expect(getGatewayToolCallerIdentity()?.mintCronRequesterGrant).toBe(nativeIssuer);
      await withGatewayToolCallerIdentity(
        { agentId: "wrapper", sessionKey: "wrapper", mintCronRequesterGrant: wrapperIssuer },
        async () => {
          expect(getGatewayToolCallerIdentity()?.mintCronRequesterGrant).toBe(nativeIssuer);
          expect(observeGatewayToolCallerOwner(a.context)).toBe("match");
          await withGatewayToolCallerIdentity(b.identity, async () => {
            expect(getGatewayToolCallerIdentity()?.mintCronRequesterGrant).toBeUndefined();
            expect(observeGatewayToolCallerOwner(a.context)).toBe("unobserved");
            expect(observeGatewayToolCallerOwner(b.context)).toBe("match");
          });
          expect(getGatewayToolCallerIdentity()?.mintCronRequesterGrant).toBe(nativeIssuer);
        },
      );
    });
    expect(nativeIssuer).not.toHaveBeenCalled();
    expect(wrapperIssuer).not.toHaveBeenCalled();
  });
  it("refreshes owner state after an earlier hook awaits and closes the admission", async () => {
    const f = await fixture();
    let lastOwner: string | undefined;
    let atCollector: string | undefined;
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.run.owner") {
          lastOwner = event.gatewayOwner;
        }
      },
      { include: ["gateway.run.owner"] },
    );
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "earlier",
      hookName: "before_tool_call",
      priority: 10,
      handler: async () => {
        await Promise.resolve();
        f.admission.close();
      },
    });
    addTestHook({
      registry,
      pluginId: "collector",
      hookName: "before_tool_call",
      priority: 0,
      handler: async () => {
        await waitForDiagnosticEventsDrained();
        atCollector = lastOwner;
      },
    });
    initializeGlobalHookRunner(registry);
    await withGatewayToolCallerIdentity(f.identity, () =>
      runBeforeToolCallHook({ toolName: "read", params: {}, ctx: { ...f.context, config: {} } }),
    );
    expect(atCollector).toBe("unobserved");
  });
  it("keeps a real admission without a native Gateway capture unobserved", async () => {
    const admission = prepareSystemAgentRunAdmission({}, "unbound-native", "test", "fixture");
    admissions.push(admission);
    const admitted = await admission.admit("embedded");
    const context = { agentId: "test", sessionKey: "fixture", runId: "unbound-native" };
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      ...context,
    });
    await withGatewayToolCallerIdentity(identity, async () => {
      expect(observeGatewayToolCallerOwner(context)).toBe("unobserved");
    });
  });
  it("does not invoke or retire source authority while observing", async () => {
    let current = true;
    const assertion = vi.fn(() => {
      if (!current) {
        throw new Error("source closed");
      }
    });
    const runId = "passive-run";
    const admission = prepareAgentRunAdmission({
      cfg: {},
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "test",
        ingress: { kind: "system", boundary: "fixture", state: "present" },
      },
      assertSourceCurrent: assertion,
    });
    admissions.push(admission);
    const admitted = await admission.admit("embedded");
    const owner: GatewayContextResolver = () => undefined;
    bindGatewayContextResolver(admitted, owner);
    bindAdmittedGatewayOwnerObservation(admitted, owner);
    const context = { agentId: "test", sessionKey: "fixture", runId };
    const identity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      ...context,
    });
    await withGatewayToolCallerIdentity(identity, async () => {
      assertion.mockClear();
      current = false;
      expect(observeGatewayToolCallerOwner(context)).toBe("match");
      expect(assertion).not.toHaveBeenCalled();
      expect(getGatewayToolCallerIdentity()?.receiptAuthority?.()).toBe(false);
      expect(assertion).toHaveBeenCalledOnce();
      expect(observeGatewayToolCallerOwner(context)).toBe("unobserved");
    });
  });

  it("selects the real admitted object and checks projections without invoking a resolver", async () => {
    const f = await fixture();
    await withGatewayToolCallerIdentity(f.identity, async () => {
      f.owner.mockClear();
      expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
      expect(f.owner).not.toHaveBeenCalled();
      expect(Object.values(getGatewayToolCallerIdentity() ?? {})).not.toContain(f.admitted);
      expect(observeGatewayToolCallerOwner({ ...f.context, runId: "wrong" })).toBe("unobserved");
      const signal = AbortSignal.abort();
      expect(observeGatewayToolCallerOwner({ ...f.context, signal })).toBe("unobserved");
      await withGatewayToolCallerIdentity(
        { agentId: "wrapper", sessionKey: "wrapper" },
        async () => {
          expect(observeGatewayToolCallerOwner(f.context)).toBe("match");
        },
      );
      await withoutGatewayToolCallerIdentity(async () => {
        expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
      });
      f.admission.close();
      expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
    });
  });
  it("does not replace identity with copied caller/admitted metadata", async () => {
    const f = await fixture();
    await withGatewayToolCallerIdentity({ ...f.identity, ...f.context }, async () => {
      expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
    });
    const copy = { ...f.admitted };
    bindGatewayContextResolver(copy, f.owner);
    bindAdmittedGatewayOwnerObservation(copy, f.owner);
    const fake = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: copy,
      ...f.context,
    });
    await withGatewayToolCallerIdentity(fake, async () => {
      expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
    });
  });
  it("distinguishes mismatched bindings and permanently ambiguous native captures", async () => {
    const f = await fixture();
    const other: GatewayContextResolver = () => f.owner();
    await withGatewayToolCallerIdentity(f.identity, async () => {
      bindGatewayContextResolver(f.admitted, other);
      expect(observeGatewayToolCallerOwner(f.context)).toBe("mismatch");
      bindGatewayContextResolver(f.admitted, f.owner);
      bindAdmittedGatewayOwnerObservation(f.admitted, other);
      bindAdmittedGatewayOwnerObservation(f.admitted, f.owner);
      expect(observeGatewayToolCallerOwner(f.context)).toBe("unobserved");
    });
  });
  it("does not lend the outer admission to another run", async () => {
    const a = await fixture(),
      b = await fixture("other-run");
    await withGatewayToolCallerIdentity(a.identity, async () => {
      await withGatewayToolCallerIdentity(b.identity, async () => {
        expect(observeGatewayToolCallerOwner(a.context)).toBe("unobserved");
        expect(observeGatewayToolCallerOwner(b.context)).toBe("match");
      });
      expect(observeGatewayToolCallerOwner(a.context)).toBe("match");
    });
  });
  it("emits before the real hook, supplies its fresh trace, and rejects replayed provenance", async () => {
    const f = await fixture();
    const events: Array<{
      event: Extract<DiagnosticEventPayload, { type: "gateway.run.owner" }>;
      metadata: DiagnosticEventMetadata;
    }> = [];
    onInternalDiagnosticEvent(
      (event, metadata) => {
        if (event.type === "gateway.run.owner") {
          events.push({ event, metadata });
        }
      },
      { include: ["gateway.run.owner"] },
    );
    const traces: DiagnosticTraceContext[] = [];
    const hook = vi.fn(
      async (_event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext) => {
        await waitForDiagnosticEventsDrained();
        expect(events.at(-1)?.event.trace).toEqual(context.gatewayOwnerObservationTrace);
        expect(events.at(-1)?.event.gatewayOwner).toBe("match");
        expect(events.at(-1)?.metadata).toMatchObject({
          internal: true,
          trusted: true,
          coreGatewayOwner: true,
        });
        if (!context.gatewayOwnerObservationTrace) {
          throw new Error("missing native observation trace");
        }
        traces.push(context.gatewayOwnerObservationTrace);
      },
    );
    const registry = createMockPluginRegistry([]);
    addTestHook({ registry, pluginId: "test-plugin", hookName: "before_tool_call", handler: hook });
    initializeGlobalHookRunner(registry);
    const parent = createDiagnosticTraceContext();
    await withGatewayToolCallerIdentity(f.identity, async () => {
      for (let n = 0; n < 2; n++) {
        const result = await runBeforeToolCallHook({
          toolName: "exec",
          toolCallId: "fixture-call",
          params: { command: "printf fixture", host: "gateway" },
          ctx: { ...f.context, config: {}, trace: parent },
        });
        expect(result.blocked).toBe(false);
      }
    });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(traces[0]?.spanId).not.toBe(traces[1]?.spanId);
    expect(traces[0]?.parentSpanId).toBe(parent.spanId);
    expect(JSON.stringify(events)).not.toContain(f.context.sessionKey);
    expect(JSON.stringify(events)).not.toContain(f.context.runId);
    const replay = events[0]?.event;
    if (!replay) {
      throw new Error("missing fixture observation");
    }
    emitTrustedDiagnosticEvent(replay);
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)?.metadata.coreGatewayOwner).toBeUndefined();
    hook.mockImplementation(async () => undefined);
    setDiagnosticsEnabledForProcess(false);
    const count = events.length;
    await withGatewayToolCallerIdentity(f.identity, () =>
      runBeforeToolCallHook({ toolName: "read", params: {}, ctx: { ...f.context, config: {} } }),
    );
    expect(events).toHaveLength(count);
  });
});
