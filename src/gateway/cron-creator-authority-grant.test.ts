import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  createCronCreatorAuthorityRunScope,
  getCronManagementAuthority,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  withCronManagementGrant,
  type CronManagementEntitlement,
} from "./cron-creator-authority-grant.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

function createManagementFixture(entitlement: boolean | CronManagementEntitlement = true) {
  const runId = "run-admin-management";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const scope = createCronCreatorAuthorityRunScope(
    runId,
    { kind: "local" },
    entitlement === false ? undefined : entitlement,
  );
  const operation = new AbortController();
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  onTestFinished(() => revokeCronCreatorAuthorityRunScope(scope));
  return {
    authority,
    identity,
    scope,
    operation,
    mint: (method = "cron.get") =>
      mintCronCreatorAuthorityGrant(scope, operation.signal, undefined, { method, authority }),
  };
}

// Legacy SDK callbacks can still hold a capture scope. Its lifecycle must close
// cleanly even though scheduled jobs no longer consume or replay captured grants.
describe("legacy cron creator scope cleanup", () => {
  it("revokes retained grants and rejects captures after run settlement", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    mintCronCreatorAuthorityGrant(scope);
    expect(scope.grantTokens.size).toBe(1);

    revokeCronCreatorAuthorityRunScope(scope);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.grantTokens.size).toBe(0);
    expect(() => mintCronCreatorAuthorityGrant(scope)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
  });

  it("releases a legacy grant when its exact operation aborts", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const operation = new AbortController();
    mintCronCreatorAuthorityGrant(scope, operation.signal);

    operation.abort(new Error("tool call timed out"));

    expect(scope.grantTokens.size).toBe(0);
    expect(() => mintCronCreatorAuthorityGrant(scope, operation.signal)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it("cleans operation abort listeners on run revocation", () => {
    const scope = createCronCreatorAuthorityRunScope("run-revoke");
    const operation = new AbortController();
    const removeListener = vi.spyOn(operation.signal, "removeEventListener");
    mintCronCreatorAuthorityGrant(scope, operation.signal);

    revokeCronCreatorAuthorityRunScope(scope);

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("cron management authority grants", () => {
  const denied = /Retry from a fresh authenticated Control UI administrator turn/;

  it("lets a live channel owner redeem management without Control UI authority", async () => {
    const fixture = createManagementFixture({ source: "channel-owner", isCurrent: () => true });
    expect(fixture.scope.controlUiAdmin).toBeUndefined();
    await expect(
      withCronManagementGrant(fixture.mint(), fixture.identity, "cron.get", async () => "allowed"),
    ).resolves.toBe("allowed");
  });

  it.each(["mint", "redeem", "commit"] as const)(
    "rejects channel owner revocation before %s",
    async (phase) => {
      let currentOwner = true;
      const fixture = createManagementFixture({
        source: "channel-owner",
        isCurrent: () => currentOwner,
      });
      const effect = vi.fn();
      if (phase === "mint") {
        currentOwner = false;
        expect(fixture.mint).toThrow(denied);
        return;
      }
      const grant = fixture.mint();
      if (phase === "redeem") {
        currentOwner = false;
      }
      await expect(
        withCronManagementGrant(grant, fixture.identity, "cron.get", async () => {
          const assertActive = getCronManagementAuthority(fixture.identity)!;
          await Promise.resolve();
          currentOwner = false;
          assertActive();
          effect();
        }),
      ).rejects.toThrow(denied);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("retains a redeemed queued operation until its exact run closes, without permitting replay", async () => {
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    let retained: (() => void) | undefined;
    await withCronManagementGrant(grant, fixture.identity, "cron.get", async () => {
      retained = getCronManagementAuthority(fixture.identity);
      expect(retained).toBeTypeOf("function");
      expect(getCronManagementAuthority({ ...fixture.identity })).toBeUndefined();
      retained!();
      await Promise.resolve();
      retained!();
    });
    expect(getCronManagementAuthority(fixture.identity)).toBeUndefined();
    expect(retained).not.toThrow();
    revokeCronCreatorAuthorityRunScope(fixture.scope);
    expect(retained).toThrow(denied);
    const replay = vi.fn();
    await expect(
      withCronManagementGrant(grant, fixture.identity, "cron.get", replay),
    ).rejects.toThrow(denied);
    expect(replay).not.toHaveBeenCalled();
  });

  it("rejects missing grants and callers without an admitted admin capability", async () => {
    const fixture = createManagementFixture(false);
    const run = vi.fn();
    expect(fixture.mint).toThrow(denied);
    await expect(
      withCronManagementGrant(
        { runId: fixture.scope.runId, token: "missing-grant" },
        fixture.identity,
        "cron.get",
        run,
      ),
    ).rejects.toThrow(denied);
    expect(run).not.toHaveBeenCalled();
  });

  it("expires at sixty seconds before redemption", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    clock.mockReturnValue(61_000);
    const run = vi.fn();
    await expect(withCronManagementGrant(grant, fixture.identity, "cron.get", run)).rejects.toThrow(
      denied,
    );
    expect(run).not.toHaveBeenCalled();
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
      const run = vi.fn();
      await expect(
        withCronManagementGrant(
          substitution === "run" ? { ...grant, runId: "other-run" } : grant,
          identity,
          substitution === "method" ? "cron.remove" : "cron.get",
          run,
        ),
      ).rejects.toThrow(denied);
      expect(run).not.toHaveBeenCalled();
      await expect(
        withCronManagementGrant(grant, fixture.identity, "cron.get", async () => "allowed"),
      ).resolves.toBe("allowed");
    },
  );

  it("keeps creator and management grants purpose-bound", async () => {
    const fixture = createManagementFixture();
    const creator = mintCronCreatorAuthorityGrant(fixture.scope);
    await expect(
      withCronManagementGrant(creator, fixture.identity, "cron.get", vi.fn()),
    ).rejects.toThrow(denied);
    expect(() => fixture.mint("cron.add")).toThrow(denied);

    const management = fixture.mint();
    await expect(
      withCronManagementGrant(management, fixture.identity, "cron.get", async () => "allowed"),
    ).resolves.toBe("allowed");
  });

  it.each([
    [
      "release",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        releaseAgentRunDelegatedAuthority(fixture.authority),
    ],
    [
      "replacement",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        claimAgentRunDelegatedAuthority(
          createTestAdmittedRunContext(fixture.scope.runId).operationalRunInstance,
        ),
    ],
    ["lifecycle rotation", () => rotateAgentRunRegistryLifecycleGeneration()],
    [
      "scope revocation",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        revokeCronCreatorAuthorityRunScope(fixture.scope),
    ],
    ["scope abort", (fixture: ReturnType<typeof createManagementFixture>) => fixture.scope.abort()],
    [
      "operation abort",
      (fixture: ReturnType<typeof createManagementFixture>) => fixture.operation.abort(),
    ],
    ["expiry", () => vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)],
  ] as const)("denies a suspended operation after %s", async (_label, invalidate) => {
    const fixture = createManagementFixture();
    const started = createDeferred();
    const resume = createDeferred();
    const effect = vi.fn();
    const operation = withCronManagementGrant(
      fixture.mint(),
      fixture.identity,
      "cron.get",
      async () => {
        const assertActive = getCronManagementAuthority(fixture.identity)!;
        assertActive();
        started.resolve();
        await resume.promise;
        assertActive();
        effect();
      },
    );
    const rejected = expect(operation).rejects.toThrow(denied);
    await started.promise;
    invalidate(fixture);
    resume.resolve();
    await rejected;
    expect(effect).not.toHaveBeenCalled();
  });
});
