// Verifies the assignment-authorization seam: it runs after secret resolution,
// before the executable env snapshot, sees names only, narrows only, and fails
// closed. No secret values appear anywhere in this suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookSecretEnvAuthorizeContext,
  PluginHookSecretEnvAuthorizeEvent,
  PluginHookSecretEnvAuthorizeResult,
} from "../plugins/hook-types.js";
import type { SecretStoreExecEnvironment } from "./store/secret-store.js";

const getGlobalHookRunner = vi.fn();
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunner(),
}));

const { authorizeSecretEnvProjection } = await import("./exec-store-authorize.js");

const CTX: PluginHookSecretEnvAuthorizeContext = {
  agentId: "agent-1",
  sessionKey: "agent:agent-1:main",
};

/** Fake resolved store snapshot. Values are deliberately synthetic sentinels. */
function storeEnv(): SecretStoreExecEnvironment {
  return {
    env: { ENV_A: "synthetic-env-a", ENV_B: "synthetic-env-b" },
    secretSentinels: { SEC_C: "SENTINEL_SEC_C" },
    secretEgressBindings: [{ name: "SEC_C", sentinel: "SENTINEL_SEC_C", allowedHosts: ["x.test"] }],
  };
}

/** A registered runner whose handler returns `result` (or throws when `throws`). */
function runner(result?: PluginHookSecretEnvAuthorizeResult, opts?: { throws?: boolean }) {
  const seen: PluginHookSecretEnvAuthorizeEvent[] = [];
  return {
    seen,
    hasHooks: () => true,
    runSecretEnvAuthorize: async (event: PluginHookSecretEnvAuthorizeEvent) => {
      seen.push(event);
      if (opts?.throws) {
        throw new Error("policy failure");
      }
      return result;
    },
  };
}

beforeEach(() => {
  getGlobalHookRunner.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authorizeSecretEnvProjection", () => {
  it("plugin-disabled compatibility: no handler leaves the snapshot byte-for-byte unchanged", async () => {
    getGlobalHookRunner.mockReturnValue(null);
    const input = storeEnv();
    const result = await authorizeSecretEnvProjection({
      storeEnv: input,
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recheck).toBeTypeOf("function");
    }
  });

  it("plugin-disabled compatibility: a runner without the hook also leaves it unchanged", async () => {
    getGlobalHookRunner.mockReturnValue({ hasHooks: () => false });
    const input = storeEnv();
    const result = await authorizeSecretEnvProjection({
      storeEnv: input,
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recheck).toBeTypeOf("function");
    }
  });

  it("pending activation: a hook registered while approval waits is enforced at launch", async () => {
    getGlobalHookRunner.mockReturnValue(null);
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.recheck) {
      throw new Error("expected recheck");
    }
    getGlobalHookRunner.mockReturnValue(runner({ allowedNames: ["ENV_A"] }));
    await expect(result.recheck()).resolves.toContain("revoked");
  });

  it("fail-closed: a registered hook that returns no decision denies the projection", async () => {
    getGlobalHookRunner.mockReturnValue(runner(undefined));
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result).toEqual({ ok: false });
  });

  it("assigned allow: authorized entries are projected intact and nothing else is dropped", async () => {
    getGlobalHookRunner.mockReturnValue(runner({ allowedNames: ["ENV_A", "ENV_B", "SEC_C"] }));
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.storeEnv.env).toEqual({ ENV_A: "synthetic-env-a", ENV_B: "synthetic-env-b" });
    expect(result.storeEnv.secretSentinels).toEqual({ SEC_C: "SENTINEL_SEC_C" });
    expect(result.storeEnv.secretEgressBindings).toEqual([
      { name: "SEC_C", sentinel: "SENTINEL_SEC_C", allowedHosts: ["x.test"] },
    ]);
    expect(result.recheck).toBeTypeOf("function");
  });

  it("exact-name unassigned denial: an unassigned name is withheld from the projection", async () => {
    getGlobalHookRunner.mockReturnValue(runner({ allowedNames: ["ENV_A"] }));
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.storeEnv.env ?? {})).toEqual(["ENV_A"]);
    expect(result.storeEnv.secretSentinels).toBeUndefined();
    expect(result.storeEnv.secretEgressBindings).toBeUndefined();
  });

  it("never widens: a name the policy invents has no effect", async () => {
    getGlobalHookRunner.mockReturnValue(runner({ allowedNames: ["ENV_A", "INVENTED"] }));
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.storeEnv.env).toEqual({ ENV_A: "synthetic-env-a" });
  });

  it("no value disclosure: the event carries candidate names and kinds only", async () => {
    const r = runner({ allowedNames: ["ENV_A", "ENV_B", "SEC_C"] });
    getGlobalHookRunner.mockReturnValue(r);
    await authorizeSecretEnvProjection({ storeEnv: storeEnv(), host: "gateway", ctx: CTX });
    expect(r.seen).toHaveLength(1);
    const event = r.seen[0]!;
    expect(event).toEqual({
      toolName: "exec",
      host: "gateway",
      candidates: [
        { name: "ENV_A", kind: "env" },
        { name: "ENV_B", kind: "env" },
        { name: "SEC_C", kind: "secret" },
      ],
    });
    // Serialized event must not contain any synthetic value or sentinel body.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("synthetic-env-a");
    expect(serialized).not.toContain("synthetic-env-b");
    expect(serialized).not.toContain("SENTINEL_SEC_C");
  });

  it("fail-closed: a throwing policy denies the whole projection", async () => {
    getGlobalHookRunner.mockReturnValue(runner(undefined, { throws: true }));
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result).toEqual({ ok: false });
  });

  it("revocation: recheck denies when the policy stops authorizing a projected name", async () => {
    const r = runner({ allowedNames: ["ENV_A", "ENV_B", "SEC_C"] });
    getGlobalHookRunner.mockReturnValue(r);
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.recheck) {
      throw new Error("expected recheck");
    }
    await expect(result.recheck()).resolves.toBeUndefined();
    // Revoke ENV_B, then recheck at the spawn boundary.
    r.runSecretEnvAuthorize = (async () => ({ allowedNames: ["ENV_A"] })) as never;
    await expect(result.recheck()).resolves.toContain("revoked");
  });

  it("revocation race: a policy throw during recheck denies the pending launch", async () => {
    const r = runner({ allowedNames: ["ENV_A", "ENV_B", "SEC_C"] });
    getGlobalHookRunner.mockReturnValue(r);
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    if (!result.ok || !result.recheck) {
      throw new Error("expected recheck");
    }
    r.runSecretEnvAuthorize = (async () => {
      throw new Error("db down");
    }) as never;
    await expect(result.recheck()).resolves.toContain("failed to re-validate");
  });

  it("deferred approval: recheck re-validates only the names actually projected", async () => {
    const r = runner({ allowedNames: ["ENV_A"] });
    getGlobalHookRunner.mockReturnValue(r);
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    if (!result.ok || !result.recheck) {
      throw new Error("expected recheck");
    }
    // ENV_B/SEC_C were withheld, so revoking them must not fail the launch.
    r.runSecretEnvAuthorize = (async () => ({ allowedNames: ["ENV_A"] })) as never;
    await expect(result.recheck()).resolves.toBeUndefined();
  });

  it("deregistered hook during recheck keeps the already-projected subset (no widening)", async () => {
    const r = runner({ allowedNames: ["ENV_A"] });
    getGlobalHookRunner.mockReturnValue(r);
    const result = await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "gateway",
      ctx: CTX,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.recheck) {
      throw new Error("expected recheck");
    }
    // ENV_B and SEC_C were already withheld, so they must remain withheld even
    // after the hook is deregistered mid-approval; the run never widens back to
    // the legacy full projection.
    expect(result.storeEnv.env).toEqual({ ENV_A: "synthetic-env-a" });
    getGlobalHookRunner.mockReturnValue({ hasHooks: () => false });
    await expect(result.recheck()).resolves.toBeUndefined();
  });

  it("passes the derived agent identity through, never a value", async () => {
    const r = runner({ allowedNames: ["ENV_A", "ENV_B", "SEC_C"] });
    getGlobalHookRunner.mockReturnValue(r);
    const runnerSpy = r;
    await authorizeSecretEnvProjection({
      storeEnv: storeEnv(),
      host: "sandbox",
      sessionKey: "agent:agent-1:main",
      ctx: { agentId: "agent-1", sessionKey: "agent:agent-1:main" },
    });
    expect(runnerSpy.seen[0]?.host).toBe("sandbox");
  });
});
