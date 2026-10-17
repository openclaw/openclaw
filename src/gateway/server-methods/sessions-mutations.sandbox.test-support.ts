import { describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { resolveSandboxRuntimeStatusAsync } from "../../agents/sandbox/runtime-status.js";
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
  const expectRefused = (respond: ReturnType<typeof vi.fn>, message: string) =>
    expect(respond).toHaveBeenCalledWith(false, undefined, errorContaining(message));
  const expectTargetRefused = (
    respond: ReturnType<typeof vi.fn>,
    method: string,
    key: string,
    message: string,
  ) => {
    if (method === "sessions.patch") {
      expectRefused(respond, message);
    } else {
      expect(respond).toHaveBeenCalledWith(
        true,
        { outcomes: [{ key, ok: false, error: errorContaining(message) }] },
        undefined,
      );
    }
  };
  describe("session sandbox mutations", () => {
    it.each([
      { method: "sessions.patch", sandboxMode: "off" },
      { method: "sessions.patch", sandboxMode: null },
      { method: "sessions.patchMany", sandboxMode: "off" },
      { method: "sessions.patchMany", sandboxMode: null },
    ] as const)(
      "$method refuses non-admin sandboxMode=$sandboxMode even when invoked directly",
      async ({ method, sandboxMode }) => {
        await withState(async (state) => {
          const key = "agent:main:sandbox-authority";
          const scope = { agentId: "main", env: state.env, sessionKey: key };
          const before = sandboxMode === null ? "off" : undefined;
          await upsertSessionEntryCore(scope, {
            sessionId: "sandbox-authority",
            updatedAt: 1,
            sandboxMode: before,
          });
          const respond = await invoke(
            method,
            method === "sessions.patch"
              ? { key, sandboxMode }
              : { targets: [{ key }], patch: { sandboxMode } },
            client(),
          );
          expectRefused(respond, "operator.admin");
          expect(loadSessionEntry(scope)?.sandboxMode).toBe(before);
        });
      },
    );

    it("persists only the selected chat's opt-out and restores inheritance with CAS", async () => {
      await withState(async (state) => {
        const key = "agent:main:sandbox-choice";
        const sibling = "agent:main:sandbox-sibling";
        const scope = { agentId: "main", env: state.env, sessionKey: key };
        const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
        await upsertSessionEntryCore(scope, {
          sessionId: "sandbox-choice",
          lifecycleRevision: "generation",
          updatedAt: 1,
        });
        await upsertSessionEntryCore(
          { ...scope, sessionKey: sibling },
          { sessionId: "sandbox-sibling", updatedAt: 1 },
        );
        const requestClient = adminClient();
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
        expect((await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey: key })).sandboxed).toBe(
          false,
        );
        expect(
          (await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey: sibling })).sandboxed,
        ).toBe(true);
        expectRefused(await patch(null, null), "changed before patch");
        expect(loadSessionEntry(scope)?.sandboxMode).toBe("off");
        expect(await patch(null, "off")).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
        expect((await resolveSandboxRuntimeStatusAsync({ cfg, sessionKey: key })).sandboxed).toBe(
          true,
        );
        expect(cfg.agents?.defaults?.sandbox?.mode).toBe("all");
      });
    });

    it.each(["sessions.patch", "sessions.patchMany"] as const)(
      "%s cannot remove mandatory containment even for an admin",
      async (method) => {
        await withState(async (state) => {
          const key = "agent:main:required-sandbox";
          const scope = { agentId: "main", env: state.env, sessionKey: key };
          await upsertSessionEntryCore(scope, {
            sessionId: "required-sandbox",
            updatedAt: 1,
            sandbox: "required",
            permissionMode: "guarded",
          });
          const respond = await invoke(
            method,
            method === "sessions.patch"
              ? { key, sandboxMode: "off", permissionMode: "full", label: "must not persist" }
              : {
                  targets: [{ key }],
                  patch: {
                    sandboxMode: "off",
                    permissionMode: "full",
                    label: "must not persist",
                  },
                },
          );
          expectTargetRefused(respond, method, key, "requires a sandbox");
          expect(loadSessionEntry(scope)).toMatchObject({
            sandbox: "required",
            permissionMode: "guarded",
          });
          expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
          expect(loadSessionEntry(scope)).not.toHaveProperty("label");
        });
      },
    );

    it("batch opt-out and reset honor each target's current sandbox expectation", async () => {
      await withState(async (state) => {
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
                error: expect.objectContaining({
                  message: expect.stringContaining("changed before patch"),
                }),
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
      });
    });

    it.each([{ expectedSessionId: "replaced" }, { expectedLifecycleRevision: "replaced" }])(
      "refuses stale sandbox recovery identity %j",
      async (expectation) => {
        await withState(async (state) => {
          const key = "agent:main:sandbox-replaced";
          const scope = { agentId: "main", env: state.env, sessionKey: key };
          await upsertSessionEntryCore(scope, {
            sessionId: "current",
            lifecycleRevision: "current",
            updatedAt: 1,
          });
          const respond = await invoke("sessions.patch", {
            key,
            sandboxMode: "off",
            expectedSandboxMode: null,
            ...expectation,
          });
          expectRefused(respond, "changed before patch");
          expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
        });
      },
    );

    it.each(["off", null] as const)(
      "refuses sandbox transition to %s while an embedded run is active",
      async (sandboxMode) => {
        await withState(async (state) => {
          const key = "agent:main:sandbox-active";
          const sessionId = "sandbox-active";
          const scope = { agentId: "main", env: state.env, sessionKey: key };
          const before = sandboxMode === null ? "off" : undefined;
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1, sandboxMode: before });
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
    ] as const)(
      "$method rechecks $change at the final sandbox write fence",
      async ({ method, change }) => {
        await withState(async (state) => {
          const key = "agent:main:sandbox-fence";
          const sessionId = "sandbox-fence";
          const scope = { agentId: "main", env: state.env, sessionKey: key };
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
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
              method === "sessions.patch"
                ? { key, sandboxMode: "off", label: "must not persist" }
                : {
                    targets: [{ key }],
                    patch: { sandboxMode: "off", label: "must not persist" },
                  },
              requestClient,
              {},
              { assertCurrent, assertTargetCurrent: assertCurrent },
            );
            expect(assertCurrent).toHaveBeenCalled();
            expectTargetRefused(
              respond,
              method,
              key,
              change === "scope-revoked" ? "operator.admin" : "Stop the active run",
            );
            expect(loadSessionEntry(scope)).not.toHaveProperty("sandboxMode");
            expect(loadSessionEntry(scope)).not.toHaveProperty("label");
          } finally {
            if (claim) {
              releaseAgentRunContext(runId, claim);
            }
          }
        });
      },
    );
  });
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
