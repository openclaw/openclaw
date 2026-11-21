import { expect, it, vi } from "vitest";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { startSessionMutationRequest } from "./sessions-mutations.native-consent.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

export function registerSessionSandboxMutationTests({
  client,
  context,
  withState,
}: {
  client: () => GatewayClient;
  context: (cfg: OpenClawConfig) => GatewayRequestContext;
  withState: (run: (state: OpenClawTestState) => Promise<void>) => Promise<void>;
}) {
  const withSession = (
    name: string,
    entry: Partial<SessionEntry>,
    run: (fixture: {
      key: string;
      scope: Parameters<typeof loadSessionEntry>[0];
      unchanged: () => void;
    }) => Promise<void>,
  ) =>
    withState(async (state) => {
      const key = `agent:main:${name}`;
      const scope = { agentId: "main", env: state.env, sessionKey: key };
      await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1, ...entry });
      const before = loadSessionEntry(scope);
      await run({ key, scope, unchanged: () => expect(loadSessionEntry(scope)).toEqual(before) });
    });
  const targetParams = (method: string, key: string, patch: Record<string, unknown>) =>
    method === "sessions.patch" ? { key, ...patch } : { targets: [{ key }], patch };
  const adminClient = () => {
    const requestClient = client();
    requestClient.connect.scopes = ["operator.admin"];
    return requestClient;
  };
  const invoke = async (
    method: "sessions.patch" | "sessions.patchMany",
    params: Record<string, unknown>,
    requestClient = adminClient(),
    cfg: OpenClawConfig = {},
    sessionMutationAuthorization?: SessionMutationAuthorization,
  ) => {
    const { respond, running } = startSessionMutationRequest(method, params, {
      client: requestClient,
      context: context(cfg),
      sessionMutationAuthorization,
    });
    await running;
    return respond;
  };
  const errorContaining = (message: string) =>
    expect.objectContaining({ message: expect.stringContaining(message) });
  const expectAccepted = (respond: ReturnType<typeof vi.fn>, result: unknown) =>
    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  const expectRefused = (respond: ReturnType<typeof vi.fn>, message: string, batchKey?: string) =>
    expect(respond).toHaveBeenCalledWith(
      ...(batchKey
        ? [
            true,
            { outcomes: [{ key: batchKey, ok: false, error: errorContaining(message) }] },
            undefined,
          ]
        : [false, undefined, errorContaining(message)]),
    );
  const methods = ["sessions.patch", "sessions.patchMany"] as const;
  type Refusal = {
    name: string;
    method: (typeof methods)[number];
    entry: Partial<SessionEntry>;
    patch: Record<string, unknown>;
    nonAdmin?: boolean;
    batchError?: boolean;
    message: string;
  };
  const refusals: Refusal[] = [
    ...methods.flatMap((method) =>
      (["off", null] as const).map((sandboxMode) => ({
        name: `non-admin sandbox=${sandboxMode}`,
        method,
        entry: { sandboxMode: sandboxMode === null ? ("off" as const) : undefined },
        patch: { sandboxMode },
        nonAdmin: true,
        message: "operator.admin",
      })),
    ),
    ...methods.map((method) => ({
      name: "mandatory containment",
      method,
      entry: { sandbox: "required" as const, permissionMode: "guarded" as const },
      patch: { sandboxMode: "off", permissionMode: "full", label: "must not persist" },
      batchError: method === "sessions.patchMany",
      message: "requires a sandbox",
    })),
    ...[{ expectedSessionId: "replaced" }, { expectedLifecycleRevision: "replaced" }].map(
      (expectation) => ({
        name: `stale ${Object.keys(expectation)[0]}`,
        method: "sessions.patch" as const,
        entry: { sessionId: "current", lifecycleRevision: "current" },
        patch: { sandboxMode: "off", expectedSandboxMode: null, ...expectation },
        message: "changed before patch",
      }),
    ),
  ];
  it.each(refusals)(
    "$method rejects $name",
    ({ method, entry, patch, nonAdmin, batchError, message }) =>
      withSession("sandbox-refusal", entry, async ({ key, unchanged }) => {
        const caller = nonAdmin ? client() : adminClient();
        expectRefused(
          await invoke(method, targetParams(method, key, patch), caller),
          message,
          batchError ? key : undefined,
        );
        unchanged();
      }),
  );

  it("keeps opt-out local and restores inheritance with CAS", () =>
    withSession("sandbox-choice", { lifecycleRevision: "generation" }, async ({ key, scope }) => {
      const sibling = "agent:main:sandbox-sibling";
      const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
      await upsertSessionEntryCore(
        { ...scope, sessionKey: sibling },
        { sessionId: "sandbox-sibling", updatedAt: 1 },
      );
      const requestClient = adminClient();
      const sandboxed = async (sessionKey: string) =>
        (await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey })).sandboxed;
      const patch = (sandboxMode: "off" | null, expectedSandboxMode: "off" | null) =>
        invoke(
          "sessions.patch",
          {
            key,
            sandboxMode,
            expectedSandboxMode,
            expectedSessionId: "sandbox-choice",
            expectedLifecycleRevision: "generation",
          },
          requestClient,
          cfg,
        );
      expectAccepted(
        await patch("off", null),
        expect.objectContaining({ entry: expect.objectContaining({ sandboxMode: "off" }) }),
      );
      expect(loadSessionEntry(scope)?.sandboxMode).toBe("off");
      expect(await sandboxed(key)).toBe(false);
      expect(await sandboxed(sibling)).toBe(true);
      expectRefused(await patch(null, null), "changed before patch");
      expect(loadSessionEntry(scope)?.sandboxMode).toBe("off");
      expectAccepted(await patch(null, "off"), expect.any(Object));
      expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
      expect(await sandboxed(key)).toBe(true);
      expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
    }));

  it("batch reset uses per-target sandbox expectations", () =>
    withState(async (state) => {
      const keys = ["agent:main:batch-sandbox-one", "agent:main:batch-sandbox-two"];
      const scope = (sessionKey: string) => ({ agentId: "main", env: state.env, sessionKey });
      for (const key of keys) {
        await upsertSessionEntryCore(scope(key), { sessionId: key, updatedAt: 1 });
      }
      let respond = await invoke("sessions.patchMany", {
        targets: keys.map((key, index) => ({
          key,
          expectedSessionId: key,
          expectedSandboxMode: index === 0 ? null : "off",
        })),
        patch: { sandboxMode: "off" },
      });
      expectAccepted(respond, {
        outcomes: [
          { key: keys[0], ok: true },
          { key: keys[1], ok: false, error: errorContaining("changed before patch") },
        ],
      });
      expect(loadSessionEntry(scope(keys[0]!))?.sandboxMode).toBe("off");
      expect(loadSessionEntry(scope(keys[1]!))).not.toHaveProperty("sandboxMode");
      respond = await invoke("sessions.patchMany", {
        targets: [{ key: keys[0], expectedSandboxMode: "off" }],
        patch: { sandboxMode: null },
      });
      expectAccepted(respond, { outcomes: [{ key: keys[0], ok: true }] });
      expect(loadSessionEntry(scope(keys[0]!))).not.toHaveProperty("sandboxMode");
    }));

  it.each(["off", null] as const)(
    "rejects sandbox=%s during embedded runs",
    async (sandboxMode) => {
      const before = sandboxMode === null ? "off" : undefined;
      await withSession("sandbox-active", { sandboxMode: before }, async ({ key, unchanged }) => {
        const sessionId = "sandbox-active";
        const handle = createEmbeddedRunHandle();
        setActiveEmbeddedRun(sessionId, handle, key);
        try {
          expectRefused(
            await invoke("sessions.patch", { key, sandboxMode }),
            "Stop the active run",
          );
          unchanged();
        } finally {
          clearActiveEmbeddedRun(sessionId, handle, key);
        }
      });
    },
  );

  it.each([
    { method: "sessions.patch", change: "run-started" },
    { method: "sessions.patch", change: "scope-revoked" },
    { method: "sessions.patchMany", change: "run-started" },
    { method: "sessions.patchMany", change: "scope-revoked" },
  ] as const)("$method rechecks $change at the final sandbox write fence", ({ method, change }) =>
    withSession("sandbox-fence", {}, async ({ key, unchanged }) => {
      const sessionId = "sandbox-fence";
      const requestClient = adminClient();
      let claim: string | undefined;
      const runId = "sandbox-fence-run";
      const assertCurrent = vi.fn(() => {
        if (change === "scope-revoked") {
          requestClient.connect.scopes = ["operator.write"];
        } else if (!claim) {
          claim = claimAgentRunContext(
            runId,
            { sessionKey: key, sessionId },
            { trackOwner: true, ownsContext: true },
          );
        }
      });
      try {
        const respond = await invoke(
          method,
          targetParams(method, key, { sandboxMode: "off", label: "must not persist" }),
          requestClient,
          {},
          { assertCurrent, assertTargetCurrent: assertCurrent },
        );
        expect(assertCurrent).toHaveBeenCalled();
        expectRefused(
          respond,
          change === "scope-revoked" ? "operator.admin" : "Stop the active run",
          method === "sessions.patchMany" ? key : undefined,
        );
        unchanged();
      } finally {
        if (claim) {
          releaseAgentRunContext(runId, claim);
        }
      }
    }),
  );
}
