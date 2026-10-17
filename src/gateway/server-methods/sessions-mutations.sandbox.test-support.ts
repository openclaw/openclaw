import { expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
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
    run: (key: string, scope: Parameters<typeof loadSessionEntry>[0]) => Promise<void>,
  ) =>
    withState(async (state) => {
      const key = `agent:main:${name}`;
      const scope = { agentId: "main", env: state.env, sessionKey: key };
      await upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1, ...entry });
      await run(key, scope);
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
    const respond = vi.fn();
    await sessionMutationHandlers[method]!({
      params,
      client: requestClient,
      context: context(cfg),
      respond,
      sessionMutationAuthorization,
    } as never);
    return respond;
  };
  const errorContaining = (message: string) =>
    expect.objectContaining({ message: expect.stringContaining(message) });
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
  it.each([
    { method: "sessions.patch", sandboxMode: "off" },
    { method: "sessions.patch", sandboxMode: null },
    { method: "sessions.patchMany", sandboxMode: "off" },
    { method: "sessions.patchMany", sandboxMode: null },
  ] as const)("$method rejects non-admin sandbox=$sandboxMode", async ({ method, sandboxMode }) => {
    const before = sandboxMode === null ? "off" : undefined;
    await withSession("sandbox-authority", { sandboxMode: before }, async (key, scope) => {
      const respond = await invoke(method, targetParams(method, key, { sandboxMode }), client());
      expectRefused(respond, "operator.admin");
      expect(loadSessionEntry(scope)?.sandboxMode).toBe(before);
    });
  });

  it("keeps opt-out local and restores inheritance with CAS", () =>
    withSession("sandbox-choice", { lifecycleRevision: "generation" }, async (key, scope) => {
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
      expect(await patch("off", null)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ entry: expect.objectContaining({ sandboxMode: "off" }) }),
        undefined,
      );
      expect(loadSessionEntry(scope)?.sandboxMode).toBe("off");
      expect(await sandboxed(key)).toBe(false);
      expect(await sandboxed(sibling)).toBe(true);
      expectRefused(await patch(null, null), "changed before patch");
      expect(loadSessionEntry(scope)?.sandboxMode).toBe("off");
      expect(await patch(null, "off")).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
      expect(await sandboxed(key)).toBe(true);
      expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
    }));

  it.each(["sessions.patch", "sessions.patchMany"] as const)(
    "%s enforces mandatory containment for admins",
    (method) =>
      withSession(
        "required-sandbox",
        { sandbox: "required", permissionMode: "guarded" },
        async (key, scope) => {
          const respond = await invoke(
            method,
            targetParams(method, key, {
              sandboxMode: "off",
              permissionMode: "full",
              label: "must not persist",
            }),
          );
          expectRefused(
            respond,
            "requires a sandbox",
            method === "sessions.patchMany" ? key : undefined,
          );
          expect(loadSessionEntry(scope)).toMatchObject({
            sandbox: "required",
            permissionMode: "guarded",
          });
          expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
          expect(loadSessionEntry(scope)).not.toHaveProperty("label");
        },
      ),
  );

  it("batch reset uses per-target sandbox expectations", () =>
    withState(async (state) => {
      const keys = ["agent:main:batch-sandbox-one", "agent:main:batch-sandbox-two"];
      const scope = (sessionKey: string) => ({ agentId: "main", env: state.env, sessionKey });
      for (const key of keys) {
        await upsertSessionEntryCore(scope(key), { sessionId: key, updatedAt: 1 });
      }
      const requestClient = adminClient();
      let respond = await invoke(
        "sessions.patchMany",
        {
          targets: keys.map((key, index) => ({
            key,
            expectedSessionId: key,
            expectedSandboxMode: index === 0 ? null : "off",
          })),
          patch: { sandboxMode: "off" },
        },
        requestClient,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { key: keys[0], ok: true },
            {
              key: keys[1],
              ok: false,
              error: errorContaining("changed before patch"),
            },
          ],
        },
        undefined,
      );
      expect(loadSessionEntry(scope(keys[0]!))?.sandboxMode).toBe("off");
      expect(loadSessionEntry(scope(keys[1]!))).not.toHaveProperty("sandboxMode");
      respond = await invoke(
        "sessions.patchMany",
        {
          targets: [{ key: keys[0], expectedSandboxMode: "off" }],
          patch: { sandboxMode: null },
        },
        requestClient,
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        { outcomes: [{ key: keys[0], ok: true }] },
        undefined,
      );
      expect(loadSessionEntry(scope(keys[0]!))).not.toHaveProperty("sandboxMode");
    }));

  it.each([{ expectedSessionId: "replaced" }, { expectedLifecycleRevision: "replaced" }])(
    "rejects stale recovery identity %j",
    (expectation) =>
      withSession(
        "sandbox-replaced",
        { sessionId: "current", lifecycleRevision: "current" },
        async (key, scope) => {
          const respond = await invoke("sessions.patch", {
            key,
            sandboxMode: "off",
            expectedSandboxMode: null,
            ...expectation,
          });
          expectRefused(respond, "changed before patch");
          expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
        },
      ),
  );

  it.each(["off", null] as const)(
    "rejects sandbox=%s during embedded runs",
    async (sandboxMode) => {
      const before = sandboxMode === null ? "off" : undefined;
      await withSession("sandbox-active", { sandboxMode: before }, async (key, scope) => {
        const sessionId = "sandbox-active";
        const handle = createEmbeddedRunHandle();
        setActiveEmbeddedRun(sessionId, handle, key);
        try {
          expectRefused(
            await invoke("sessions.patch", { key, sandboxMode }),
            "Stop the active run",
          );
          expect(loadSessionEntry(scope)?.sandboxMode).toBe(before);
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
    withSession("sandbox-fence", {}, async (key, scope) => {
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
        expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
        expect(loadSessionEntry(scope)).not.toHaveProperty("label");
      } finally {
        if (claim) {
          releaseAgentRunContext(runId, claim);
        }
      }
    }),
  );
}

export function registerSessionSandboxStickyModelTests({
  getConfig,
  patchSession,
  configMutationRequested,
  getPersistedConfig,
}: {
  getConfig: () => OpenClawConfig;
  patchSession: (params: Record<string, unknown>) => Promise<readonly unknown[]>;
  configMutationRequested: () => boolean;
  getPersistedConfig: () => OpenClawConfig | undefined;
}) {
  it.each(["agent", "global"] as const)(
    "keeps combined sandbox recovery session-local with %s defaults",
    async (scope) => {
      getConfig().agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:main:dm:native-policy-recovery-${scope}`;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: `native-policy-recovery-${scope}`, updatedAt: 1 },
      );
      const response = await patchSession({
        key: sessionKey,
        model: "openai/gpt-5.6-sol",
        sandboxMode: "off",
        permissionMode: "full",
        expectedSessionId: `native-policy-recovery-${scope}`,
        expectedSandboxMode: null,
      });
      expect(response[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        modelOverride: "gpt-5.6-sol",
        sandboxMode: "off",
        permissionMode: "full",
      });
      expect(configMutationRequested()).toBe(false);
      expect(getPersistedConfig()).toBeUndefined();
    },
  );
}
