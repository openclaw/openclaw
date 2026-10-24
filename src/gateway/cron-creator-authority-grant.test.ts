import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "../infra/exec-approvals-core.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptParamsV2,
} from "../plugin-sdk/agent-harness-runtime.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  attachCronStreamExecPolicy,
  consumeCronCreatorAuthorityGrant as consume,
  createCronCreatorAuthorityRunScope,
  getCronManagementAuthority,
  getCronManagementCallerOrigin,
  mintCronCreatorAuthorityGrant as mint,
  resolveCronCreatorAuthorityGrantProvenance as provenance,
  revokeCronCreatorAuthorityRunScope as revokeScope,
  withCronManagementGrant as withGrant,
} from "./cron-creator-authority-grant.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

const denied =
  /Retry from a fresh authenticated configured channel owner or Control UI administrator turn/;
function createScope(...args: Parameters<typeof createCronCreatorAuthorityRunScope>) {
  const scope = createCronCreatorAuthorityRunScope(...args);
  onTestFinished(() => revokeScope(scope));
  return scope;
}
async function expectDenied(operation: (run: () => Promise<unknown>) => Promise<unknown>) {
  const run = vi.fn(async () => undefined);
  await expect(operation(run)).rejects.toThrow(denied);
  expect(run).not.toHaveBeenCalled();
}

function createManagementFixture(controlUiAdmin = true) {
  let continuationCurrent = true;
  const runId = "run-admin-management";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const scope = createScope(
    runId,
    { kind: "local" },
    controlUiAdmin ? { source: "control-ui-admin" } : undefined,
    () => continuationCurrent,
  );
  const operation = new AbortController();
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  const run = <T>(
    grant: Parameters<typeof withGrant>[0],
    body: () => Promise<T>,
    method = "cron.get",
    caller = identity,
  ) => withGrant(grant, caller, method, body);
  return {
    authority,
    identity,
    scope,
    operation,
    revokeContinuation: () => {
      continuationCurrent = false;
    },
    mint: (method = "cron.get") => mint(scope, operation.signal, undefined, { method, authority }),
    run,
    deny: (grant: Parameters<typeof withGrant>[0], method = "cron.get", caller = identity) =>
      expectDenied((body) => run(grant, body, method, caller)),
  };
}

describe("cron creator authority grants", () => {
  it("preserves the Control UI admin SDK projection without granting creator authority", () => {
    const scope = createScope("sdk-compat", { kind: "unknown" }, { source: "control-ui-admin" });
    const legacy: Pick<EmbeddedRunAttemptParams, "cronCreatorAuthorityCapability"> = {
      cronCreatorAuthorityCapability: scope,
    };
    const current: Pick<EmbeddedRunAttemptParamsV2, "cronCreatorAuthorityCapability"> = legacy;
    expect(legacy.cronCreatorAuthorityCapability?.controlUiAdmin).toBe(true);
    expect(current.cronCreatorAuthorityCapability?.controlUiAdmin).toBe(true);
    expect(() => mint(scope)).toThrow("Automation creation is not granted");
  });
  it("carries direct-local origin without claiming channel requester authority", () => {
    const local = createScope("run-local", { kind: "local" });
    const grant = mint(local, undefined, undefined, undefined, "requester");
    expect(provenance(grant, local.runId)).toEqual({
      capturesRuntimeAuthority: false,
      callerOrigin: { kind: "local" },
    });
    const external = createScope("run-external", { kind: "external", channel: "discord" });
    expect(() => mint(external, undefined, undefined, undefined, "requester")).toThrow(
      "requires authenticated creator facts",
    );
  });

  it("rejects run substitution and transports private runtime authority only once", () => {
    const scope = createScope("run-authority");
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const grant = mint(scope, undefined, runtimeAuthority);
    expect(grant).toEqual({ runId: "run-authority", token: expect.any(String) });
    expect(() => consume({ ...grant, runId: "run-other" })).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    expect(consume(grant).authority).toEqual(runtimeAuthority);
    expect(() => consume(grant)).toThrow("Configured MCP cron authority is no longer active");
  });

  it.each([
    "issuer",
    "scope",
    "scope abort",
    "run settlement",
    "operation",
    "channel owner",
  ] as const)(
    "rejects retained creator authority when its original %s is revoked after consumption",
    async (revoked) => {
      const current = { issuer: true, scope: true, channel: true };
      const scope = createScope(
        "retained-creator",
        { kind: "local" },
        { source: "channel-owner", isCurrent: () => current.channel },
        () => current.scope,
      );
      const operation = new AbortController();
      const mintCurrent = () =>
        mint(scope, operation.signal, undefined, undefined, "runtime", () => current.issuer);
      const grant = mintCurrent();
      const consumed = consume(grant);
      const unspent = mintCurrent();
      expect(consumed.authority).toBeUndefined();
      expect(consumed.assertCurrent).not.toThrow();
      expect(() => consume(grant)).toThrow("no longer active");
      await Promise.resolve();
      if (revoked === "issuer" || revoked === "scope") {
        current[revoked] = false;
      } else if (revoked === "channel owner") {
        current.channel = false;
      } else if (revoked === "run settlement") {
        revokeScope(scope);
        expect(scope.signal.aborted).toBe(true);
      } else if (revoked === "operation") {
        operation.abort(new Error("tool call timed out"));
      } else {
        scope.abort();
      }
      expect(consumed.assertCurrent).toThrow("no longer active");
      expect(() => consume(unspent)).toThrow("Configured MCP cron authority is no longer active");
    },
  );
});

describe("cron management authority grants", () => {
  it("retains a redeemed queued operation until its exact run closes, without permitting replay", async () => {
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    let retained: (() => void) | undefined;
    await fixture.run(grant, async () => {
      retained = getCronManagementAuthority(fixture.identity);
      expect(retained).toBeTypeOf("function");
      expect(getCronManagementCallerOrigin(fixture.identity)).toEqual({ kind: "local" });
      expect(getCronManagementAuthority({ ...fixture.identity })).toBeUndefined();
      expect(getCronManagementCallerOrigin({ ...fixture.identity })).toBeUndefined();
      retained!();
      await Promise.resolve();
      retained!();
    });
    expect(getCronManagementAuthority(fixture.identity)).toBeUndefined();
    expect(getCronManagementCallerOrigin(fixture.identity)).toBeUndefined();
    expect(retained).not.toThrow();
    revokeScope(fixture.scope);
    expect(retained).toThrow(denied);
    await fixture.deny(grant);
  });

  it("rejects missing grants and callers without an admitted admin capability", async () => {
    const fixture = createManagementFixture(false);
    expect(fixture.mint).toThrow(denied);
    await fixture.deny({ runId: fixture.scope.runId, token: "missing-grant" });
  });

  it("expires at sixty seconds before redemption", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    clock.mockReturnValue(61_000);
    await fixture.deny(grant);
  });

  it("retains only the stream mutation through one bounded approval wait", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = createManagementFixture();
    const ordinaryGrant = fixture.mint("cron.update");
    const streamGrant = fixture.mint("cron.update");
    const policy = { kind: "resolved" as const, assertCurrent: () => {} };
    attachCronStreamExecPolicy(streamGrant, policy);
    clock.mockReturnValue(51_000);
    attachCronStreamExecPolicy(streamGrant, policy);
    clock.mockReturnValue(61_000);
    await fixture.deny(ordinaryGrant, "cron.update");

    const effect = vi.fn();
    await withGrant(streamGrant, fixture.identity, "cron.update", async () => {
      const assertActive = getCronManagementAuthority(fixture.identity)!;
      await Promise.resolve();
      assertActive();
      effect();
      clock.mockReturnValue(1_000 + DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000);
      expect(assertActive).toThrow(denied);
    });
    expect(effect).toHaveBeenCalledOnce();
    await fixture.deny(streamGrant, "cron.update");
  });

  it.each(["method", "run", "instance", "lifecycle", "claim"] as const)(
    "rejects %s substitution without spending the original grant",
    async (substitution) => {
      const fixture = createManagementFixture();
      const grant = fixture.mint();
      const identity: AgentRuntimeIdentity = {
        ...fixture.identity,
        operationalRunInstance: {
          ...fixture.identity.operationalRunInstance,
          ...(substitution === "instance" ? { instanceId: "other-instance" } : {}),
        },
        delegatedAuthority: {
          ...fixture.identity.delegatedAuthority,
          ...(substitution === "lifecycle" ? { lifecycleGeneration: "other-lifecycle" } : {}),
          ...(substitution === "claim" ? { claimId: "other-claim" } : {}),
        },
      };
      await fixture.deny(
        substitution === "run" ? { ...grant, runId: "other-run" } : grant,
        substitution === "method" ? "cron.remove" : "cron.get",
        identity,
      );
      await expect(fixture.run(grant, async () => "allowed")).resolves.toBe("allowed");
    },
  );

  it("keeps creator and management grants purpose-bound", async () => {
    const fixture = createManagementFixture();
    const creator = mint(fixture.scope);
    await fixture.deny(creator);
    expect(() => consume(creator)).not.toThrow();
    expect(() => fixture.mint("cron.add")).toThrow(denied);

    const management = fixture.mint();
    expect(() => consume(management)).toThrow("Configured MCP cron authority is no longer active");
    await expect(fixture.run(management, async () => "allowed")).resolves.toBe("allowed");
  });

  type Fixture = ReturnType<typeof createManagementFixture>;
  it.each([
    ["continuation ownership loss", (fixture: Fixture) => fixture.revokeContinuation()],
    ["release", (fixture: Fixture) => releaseAgentRunDelegatedAuthority(fixture.authority)],
    [
      "replacement",
      (fixture: Fixture) =>
        claimAgentRunDelegatedAuthority(
          createTestAdmittedRunContext(fixture.scope.runId).operationalRunInstance,
        ),
    ],
    ["lifecycle rotation", () => rotateAgentRunRegistryLifecycleGeneration()],
    ["scope revocation", (fixture: Fixture) => revokeScope(fixture.scope)],
    ["scope abort", (fixture: Fixture) => fixture.scope.abort()],
    ["operation abort", (fixture: Fixture) => fixture.operation.abort()],
    [
      "expiry",
      () =>
        vi
          .spyOn(Date, "now")
          .mockReturnValue(Date.now() + DEFAULT_EXEC_APPROVAL_TIMEOUT_MS + 10_000),
    ],
  ] as const)("denies a suspended stream approval after %s", async (_label, invalidate) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = createManagementFixture();
    const grant = fixture.mint("cron.update");
    attachCronStreamExecPolicy(grant, { kind: "resolved", assertCurrent: () => {} });
    const started = createDeferred();
    const resume = createDeferred();
    const effect = vi.fn();
    const operation = withGrant(grant, fixture.identity, "cron.update", async () => {
      const assertActive = getCronManagementAuthority(fixture.identity)!;
      assertActive();
      started.resolve();
      await resume.promise;
      assertActive();
      effect();
    });
    const rejected = expect(operation).rejects.toThrow(denied);
    await started.promise;
    clock.mockReturnValue(61_000);
    invalidate(fixture);
    resume.resolve();
    await rejected;
    expect(effect).not.toHaveBeenCalled();
  });
});
