// Real Gateway, tools, transport, plugin policy, runtime leases and completion registry.
// Only external model responses and the access-grant backend are private fixtures.
// Policy-backed completion must outlive the producer without extending its lease.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID, X509Certificate } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM } from "../../test/helpers/tls-fixture.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as attemptBackend from "../agents/embedded-agent-runner/run/backend.js";
import * as runtimeLease from "../agents/prepared-model-runtime.plugin-lifetime.js";
import * as announceDelivery from "../agents/subagents/announce/subagent-announce-delivery.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { isClaimedByLiveRequesterTurn } from "../agents/subagents/registry/subagent-requester-turn-liveness.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  emitAgentEventIfCurrent,
  onAgentEvent,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { getPluginInstance, pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import * as accessPolicy from "./operator-access-policy.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import {
  createSubagentModelConfig,
  createSubagentStopFixture,
  findSubagentRecords,
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type Route = "fresh" | "followup";
function scenario(route: Route) {
  const id = randomUUID();
  return {
    route,
    parent: "agent:main:completion-lease-" + id,
    prompt: "COMPLETION_PARENT_" + id,
    childTask: "COMPLETION_CHILD_" + id,
    followup: "CONTINUE_CHILD_" + id,
    answer: "SAVED_CHILD_FINAL_" + id,
    receipt: undefined as SpawnReceipt | undefined,
    successor: undefined as string | undefined,
    observedProducerScope: undefined as PluginInvocationScope | undefined,
    producerScope: undefined as PluginInvocationScope | undefined,
    completionAuthority: undefined as AdmittedRunOperatorAuthority | undefined,
    originalGrant: undefined as AbortSignal | undefined,
    revokeGrant: undefined as (() => void) | undefined,
    terminalEvent: undefined as AgentEventPayload | undefined,
    spawned: createDeferred<SpawnReceipt>(),
    paused: createDeferred(),
    sent: createDeferred(),
    producerCanYield: createDeferred(),
    producerReleased: createDeferred(),
    finishChild: createDeferred(),
    terminal: createDeferred(),
    deliveryEntered: createDeferred(),
    deliver: createDeferred(),
    holdDelivery: false,
    settled: createDeferred(),
    deliveries: 0,
    phase: 0,
    finishBeforeRelease: false,
  };
}
type Scenario = ReturnType<typeof scenario>;
let active: Scenario | undefined;
let fixture: Awaited<ReturnType<typeof createSubagentStopFixture>>;
let gateway: Awaited<ReturnType<typeof fixture.start>>;
let model: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>>;
let stopRows: (() => void) | undefined;
let stopEvents: (() => void) | undefined;
const policyAuthorities = new Set<GatewayOperatorAccessAuthority>();
let retirement: Promise<unknown> | undefined;
const policyEvent = "completion-lease-policy-" + randomUUID();
const errors: unknown[] = [];
let leaseScopes = new WeakSet<PluginInvocationScope>();
let releasedScopes = new WeakSet<PluginInvocationScope>();
// Observe a real policy call in the producer frame; do not replace its verdict.
const observePolicy = (grant: AbortController) => {
  if (active) {
    active.originalGrant = grant.signal;
    active.revokeGrant = () => grant.abort(new Error("private completion grant revoked"));
  }
};

const healthyControlName =
  "healthy fresh spawn without a policy dependency completes once after producer exit";

beforeEach(async ({ task }) => {
  const withPolicy = task.name !== healthyControlName;
  active = undefined;
  errors.length = 0;
  policyAuthorities.clear();
  retirement = undefined;
  const resolveAccess = accessPolicy.resolveGatewayOperatorAccessAuthority;
  vi.spyOn(accessPolicy, "resolveGatewayOperatorAccessAuthority").mockImplementation((...args) => {
    const authority = resolveAccess(...args);
    if (authority?.gatewayAccessGrant?.pluginId === "person-access") {
      policyAuthorities.add(authority);
    }
    return authority;
  });
  const deliverAnnouncement = announceDelivery.deliverSubagentAnnouncement;
  vi.spyOn(announceDelivery, "deliverSubagentAnnouncement").mockImplementation(async (params) => {
    const current = active;
    if (
      current?.holdDelivery &&
      params.sourceRunId === (current.successor ?? current.receipt?.runId)
    ) {
      // Pause transport admission only after the real child terminal has been prepared.
      // The original implementation, custody and policy checks still decide the outcome.
      current.deliveryEntered.resolve();
      await current.deliver.promise;
    }
    return deliverAnnouncement(params);
  });
  stopEvents = onAgentEvent((event) => {
    if (
      active?.receipt &&
      event.runId === (active.successor ?? active.receipt.runId) &&
      event.stream === "lifecycle" &&
      event.data.phase === "end" &&
      !event.data.yielded
    ) {
      active.terminalEvent = event;
    }
  });
  process.on(policyEvent, observePolicy);
  // The observer calls the original method with its exact scope receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const release = PluginInvocationScope.prototype.release;
  leaseScopes = new WeakSet<PluginInvocationScope>();
  releasedScopes = new WeakSet<PluginInvocationScope>();
  const createLease = runtimeLease.createPreparedModelRuntimeLease;
  vi.spyOn(runtimeLease, "createPreparedModelRuntimeLease").mockImplementation((...args) => {
    const lease = createLease(...args);
    const scope = lease.run(() => pluginInvocationContext.getStore());
    if (scope instanceof PluginInvocationScope) {
      leaseScopes.add(scope);
    }
    return lease;
  });
  vi.spyOn(PluginInvocationScope.prototype, "release").mockImplementation(function () {
    release.call(this);
    releasedScopes.add(this);
    if (this === active?.producerScope) {
      active.producerReleased.resolve();
    }
  });
  const runAttempt = attemptBackend.runEmbeddedAttemptWithBackend;
  vi.spyOn(attemptBackend, "runEmbeddedAttemptWithBackend").mockImplementation(
    (params, ...rest) => {
      const current = active;
      const scope = pluginInvocationContext.getStore();
      if (
        current &&
        params.sessionKey === current.parent &&
        !current.producerScope &&
        scope instanceof PluginInvocationScope &&
        leaseScopes.has(scope)
      ) {
        current.observedProducerScope = scope;
      }
      return runAttempt(params, ...rest);
    },
  );
  model = await startOpenAiResponsesModelServer({
    modelId: "completion-lease",
    bindError: "Expected private completion model listener",
    async onRequest(request, response) {
      try {
        const raw = await readRequestText(request);
        const body: unknown = JSON.parse(raw);
        const current = active;
        if (!current) {
          throw new Error("Model request without an active scenario");
        }
        const reply = (text: string) =>
          writeOpenAiResponsesText(response, {
            text,
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        if (raw.includes(current.prompt)) {
          if (raw.includes(current.answer)) {
            current.deliveries++;
            reply("PARENT_RECEIVED_CHILD");
            return;
          }
          if (current.phase++ === 0) {
            writeToolCall(response, "sessions_spawn", {
              task: current.childTask,
              context: "isolated",
              cleanup: "keep",
              completionTarget: "parent",
            });
            return;
          }
          const receipt = findSubagentSpawnReceipt(body);
          if (!receipt) {
            throw new Error("Parent never received real spawn acceptance");
          }
          current.receipt = receipt;
          current.spawned.resolve(receipt);
          if (current.route === "followup" && current.phase === 2) {
            await current.paused.promise;
            writeToolCall(response, "sessions_send", {
              sessionKey: receipt.childSessionKey,
              mode: "resume",
              timeoutSeconds: 0,
              message: current.followup,
            });
            return;
          }
          if (current.route === "followup" && current.phase === 3) {
            const sent = findSubagentRecords(
              body,
              (record) =>
                record.status === "accepted" &&
                typeof record.runId === "string" &&
                record.runId !== receipt.runId,
            )[0];
            if (!sent) {
              throw new Error("Parent followup not accepted");
            }
            current.successor = String(sent.runId);
            current.sent.resolve();
          }
          await current.producerCanYield.promise;
          if (current.finishBeforeRelease) {
            reply("PRODUCER_FINISHED");
          } else {
            writeToolCall(response, "sessions_yield", {});
          }
          return;
        }
        if (raw.includes(current.childTask)) {
          if (current.route === "followup" && !raw.includes(current.followup)) {
            writeToolCall(response, "sessions_yield", { waitFor: "message" });
            return;
          }
          await current.finishChild.promise;
          reply(current.answer);
          return;
        }
        throw new Error("Unexpected model request outside exact private sessions");
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  });
  fixture = await createSubagentStopFixture("completion-lease-policy", model.baseUrl + "/v1");
  const { databasePath, assertDatabasePath } = installPrivateUpdateHandoffStore(fixture.state.root);
  assertDatabasePath(databasePath);
  Object.assign(
    fixture.cfg,
    createSubagentModelConfig(fixture.state.workspaceDir, {
      modelId: "completion-lease",
      baseUrl: model.baseUrl + "/v1",
      runtime: true,
    }),
  );
  if (withPolicy) {
    const pluginDir = fixture.state.statePath("person-access");
    await fixture.state.writeJson("person-access/package.json", {
      name: "person-access",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    await fixture.state.writeJson("person-access/openclaw.plugin.json", {
      id: "person-access",
      generationOverlap: true,
      activation: { onStartup: true },
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    });
    await fixture.state.writeText(
      "person-access/index.cjs",
      [
        "const grant = new AbortController();",
        'module.exports = { id: "person-access", register(api) {',
        'const authority = () => ({ grantId: "private-completion-grant", signal: grant.signal,',
        "assertCurrent() { grant.signal.throwIfAborted(); process.emit(" +
          JSON.stringify(policyEvent) +
          ", grant); } });",
        "api.registerGatewayAccessPolicy({ authorize: authority,",
        'resume({ grantId }) { return grantId === "private-completion-grant" ? authority() : undefined; }',
        "}); } };",
      ].join("\n"),
    );
    fixture.cfg.plugins = {
      enabled: true,
      allow: ["person-access"],
      load: { paths: [pluginDir] },
      entries: { "person-access": { enabled: true } },
      slots: { memory: "none" },
    };
    fixture.cfg.gateway!.roles!.definitions.administrator!.accessPolicyPlugin = "person-access";
  }
  stopRows = subscribeSubagentRunChanges("persistence", () => {
    const current = active;
    if (!current?.receipt) {
      return;
    }
    const initial = subagentRuns.get(current.receipt.runId);
    if (initial?.pauseReason === "sessions_yield") {
      current.paused.resolve();
    }
    const entry = subagentRuns.get(current.successor ?? current.receipt.runId);
    if (entry?.execution.status === "terminal" && !entry.pauseReason) {
      current.terminal.resolve();
    }
    if (
      entry?.delivery?.status === "delivered" ||
      entry?.delivery?.status === "failed" ||
      entry?.delivery?.status === "suspended"
    ) {
      current.settled.resolve();
    }
  });
  vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  gateway = await startGatewayWithClient({
    cfg: fixture.cfg,
    configPath: fixture.state.configPath,
    auth: fixture.cfg.gateway?.auth,
    edgeAuthHeaders: {
      "x-forwarded-for": "203.0.113.81",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "subagent-stop-administrator@example.test",
    },
    secure: true,
    tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin: "https://control.example.com",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    beforeConnect: async (server) => {
      await server.startupSettled;
      const registry = getActivePluginRegistry();
      if (!withPolicy) {
        expect(registry?.gatewayAccessPolicies.map((entry) => entry.pluginId)).not.toContain(
          "person-access",
        );
        return;
      }
      expect(registry?.gatewayAccessPolicies.map((entry) => entry.pluginId)).toContain(
        "person-access",
      );
    },
  });
}, 90_000);

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") {
    console.error("completion ordering", {
      route: active?.route,
      beforeRelease: active?.finishBeforeRelease,
      producerReleased: active?.producerScope && releasedScopes.has(active.producerScope),
      originalGrantAborted: active?.originalGrant?.aborted,
      authorityAborted: active?.completionAuthority?.signal?.aborted,
      delivery:
        active?.receipt && subagentRuns.get(active.successor ?? active.receipt.runId)?.delivery,
      captures: policyAuthorities.size,
    });
  }
  active?.finishChild.resolve();
  active?.deliver.resolve();
  active?.paused.resolve();
  active?.producerCanYield.resolve();
  stopRows?.();
  stopEvents?.();
  try {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "completion lease regression complete" });
    }
    await resetSubagentRegistryForTests({ persist: false });
  } finally {
    await retirement;
    await model?.close();
    await fixture?.state.cleanup();
    process.off(policyEvent, observePolicy);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}, 90_000);

const cases = [
  { name: healthyControlName, route: "fresh", policy: false, beforeRelease: false },
  {
    name: "same-policy authority stays current while private completion waits for its live producer",
    route: "fresh",
    policy: true,
    beforeRelease: true,
  },
  ...(["fresh", "followup"] as const).map((route) => ({
    name: route + " child final reaches its parent once after its producer lease releases",
    route,
    policy: true,
    beforeRelease: false,
  })),
  ...(["grant-revoked", "plugin-lifetime-retired"] as const).map((invalidation) => ({
    name: invalidation + " after producer release rejects completion without recapture",
    route: "fresh" as const,
    policy: true,
    beforeRelease: false,
    invalidation,
  })),
] as const;

for (const testCase of cases) {
  const { name, route, policy, beforeRelease } = testCase;
  const invalidation = "invalidation" in testCase ? testCase.invalidation : undefined;
  it(name, { timeout: 90_000 }, async ({ signal }) => {
    const current = scenario(route);
    current.finishBeforeRelease = beforeRelease;
    current.holdDelivery = invalidation !== undefined;
    active = current;
    const parent = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: current.parent,
      message: current.prompt,
      idempotencyKey: randomUUID(),
      deliver: false,
    });
    const child = await withinTest(current.spawned.promise, signal);
    if (subagentRuns.get(child.runId)?.pauseReason === "sessions_yield") {
      current.paused.resolve();
    }
    if (route === "followup") {
      await withinTest(current.sent.promise, signal);
    }
    const runId = current.successor ?? child.runId;
    const owned = subagentRuns.get(runId);
    expect(owned).toBeDefined();
    current.completionAuthority = subagentRuns.runWithCompletionAuthority(
      owned!,
      () => getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
    );
    expect(current.completionAuthority).toBeDefined();
    expect(current.completionAuthority?.gatewayAccessGrant).toEqual(
      policy
        ? {
            pluginId: "person-access",
            grantId: "private-completion-grant",
          }
        : null,
    );
    expect(current.completionAuthority?.signal.aborted).toBe(false);
    expect(() => current.completionAuthority!.assertCurrent()).not.toThrow();
    if (route === "followup") {
      expect(owned).toMatchObject({ taskRunId: child.runId, generation: 2 });
      expect(subagentRuns.has(child.runId)).toBe(false);
    }
    if (policy) {
      // Freeze only the exact parent attempt after acceptance. An earlier child
      // pause cannot satisfy this disposal latch; never retain the observed scope.
      current.producerScope = current.observedProducerScope;
      expect(current.producerScope).toBeDefined();
      expect(releasedScopes.has(current.producerScope!)).toBe(false);
      if (!beforeRelease) {
        current.producerCanYield.resolve();
        await withinTest(current.producerReleased.promise, signal);
        expect(releasedScopes.has(current.producerScope!)).toBe(true);
      }
    } else {
      // No plugin dependency means no plugin invocation scope to observe.
      current.producerCanYield.resolve();
      await expect(
        gateway.client.request("agent.wait", { runId: parent.runId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
    }
    current.finishChild.resolve();
    if (invalidation) {
      await withinTest(current.terminal.promise, signal);
      await withinTest(current.deliveryEntered.promise, signal);
      expect(current.deliveries).toBe(0);
    }
    const capturesBeforeInvalidation = policyAuthorities.size;
    if (invalidation === "grant-revoked") {
      expect(current.revokeGrant).toBeDefined();
      current.revokeGrant!();
    } else if (invalidation === "plugin-lifetime-retired") {
      const record = getActivePluginRegistry()!.plugins.find(
        (entry) => entry.id === "person-access",
      )!;
      const instance = getPluginInstance(record)!;
      expect(instance).toBeDefined();
      retirement = instance.dispose();
      await withinTest(retirement, signal);
      expect(instance.lifecycle.signal.aborted).toBe(true);
    }
    current.deliver.resolve();
    if (invalidation) {
      await withinTest(current.settled.promise, signal);
      expect(current.deliveries).toBe(0);
      expect(current.completionAuthority?.signal.aborted).toBe(true);
      expect(policyAuthorities.size).toBe(capturesBeforeInvalidation);
      expect(policyAuthorities.size).toBeGreaterThan(0);
      expect([...policyAuthorities].map((authority) => authority.failureCause)).toContain(
        invalidation,
      );
      expect(subagentRuns.get(runId)?.delivery).toMatchObject({
        status: "failed",
        disposition: "intentional_non_delivery",
      });
      expect(current.originalGrant?.aborted).toBe(invalidation === "grant-revoked");
      return;
    }
    await expect(
      gateway.client.request("agent.wait", { runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    await withinTest(current.terminal.promise, signal);
    expect(subagentRuns.get(runId)?.execution).toMatchObject({
      status: "terminal",
      outcome: { status: "ok" },
    });
    const entry = await readSessionEntryReadOnlyInWorker({
      agentId: "main",
      sessionKey: child.childSessionKey,
    });
    expect(entry).toBeDefined();
    const transcript = await loadTranscriptEvents({
      agentId: "main",
      sessionKey: child.childSessionKey,
      sessionId: entry!.sessionId,
    });
    expect(JSON.stringify(transcript)).toContain(current.answer);
    if (beforeRelease) {
      // startSubagentAnnounceCleanupFlow deliberately defers private delivery while
      // this exact physical requester owns the child. Waiting for Gateway admission
      // before releasing the producer would deadlock, not form a healthy control.
      const completed = subagentRuns.get(runId)!;
      expect(isClaimedByLiveRequesterTurn(completed)).toBe(true);
      expect(releasedScopes.has(current.producerScope!)).toBe(false);
      expect(() =>
        subagentRuns.runWithCompletionAuthority(completed, () => {
          current.completionAuthority!.assertCurrent();
        }),
      ).not.toThrow();
      expect(current.completionAuthority?.signal.aborted).toBe(false);
      expect(current.deliveries).toBe(0);
      expect(completed.delivery?.status).not.toBe("delivered");
      // Preserve the live-authority/scheduler control, then let the ordinary producer
      // finish and verify the healthy completion reaches its parent exactly once.
      current.producerCanYield.resolve();
      await withinTest(current.producerReleased.promise, signal);
    }
    await withinTest(current.settled.promise, signal);
    expect(errors).toEqual([]);
    if (policy) {
      expect(current.originalGrant?.aborted).toBe(false);
      expect(current.completionAuthority?.gatewayAccessGrant).toEqual({
        pluginId: "person-access",
        grantId: "private-completion-grant",
      });
    }
    expect(current.deliveries, JSON.stringify(subagentRuns.get(runId)?.delivery)).toBe(1);
    expect(subagentRuns.get(runId)?.delivery?.status).toBe("delivered");
    if (route === "followup") {
      expect(current.terminalEvent).toBeDefined();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      const completed = subagentRuns.get(runId)!;
      expect(completed.cleanupCompletedAt).toBeTypeOf("number");
      expect(subagentRuns.getRequesterRunInstance(completed)).toBeUndefined();
      // Admit the actual terminal evidence again, rather than merely asserting
      // rejection by the public event owner before registry duplicate handling.
      expect(emitAgentEventIfCurrent(current.terminalEvent!)).toBe(true);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(current.deliveries).toBe(1);
      expect(subagentRuns.get(runId)?.cleanupCompletedAt).toBe(completed.cleanupCompletedAt);
      expect(subagentRuns.getRequesterRunInstance(subagentRuns.get(runId)!)).toBeUndefined();
    }
  });
}
