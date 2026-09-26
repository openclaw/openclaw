import { describe, expect, it, vi, type Mock } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { preparePublishedModelRuntimeChoice } from "../../agents/model-runtime-choice.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createGatewaySession } from "../session-create-service.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const nativeModel: ModelCatalogEntry = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  name: "Native model",
  reasoning: false,
  nativeRuntime: "claude-cli",
};

export function registerSessionNativeRuntimeConsentTests(support: {
  getConfig: () => OpenClawConfig;
  catalogSnapshot: (
    entries: ModelCatalogEntry[],
  ) => Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>;
  client: (scopes: string[]) => GatewayClient;
  context: () => GatewayRequestContext & {
    loadGatewayModelCatalogSnapshot: Mock<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>;
  };
  patchSession: (
    params: Record<string, unknown>,
    scopes?: string[],
    requestContext?: GatewayRequestContext,
    requestClient?: GatewayClient,
  ) => Promise<Parameters<RespondFn>>;
  prepareRuntime: Mock<typeof preparePublishedModelRuntimeChoice>;
  configMutationRequested: () => boolean;
  queueRuntimeSelection: (sessionKey: string) => Promise<{ provider: string; model: string }>;
}): void {
  const { catalogSnapshot, client, context, patchSession, queueRuntimeSelection } = support;
  describe("native runtime permission consent", () => {
    const harness: AgentHarness = {
      id: "claude-cli",
      label: "Native fixture",
      executionEnvironment: "host-only",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
    };
    let nextConsentSession = 0;

    async function prepareConsent(entry: Partial<SessionEntry> = {}) {
      const sessionKey = `agent:main:native-consent-${++nextConsentSession}`;
      const scope = { agentId: "main", sessionKey };
      support.getConfig().agents!.defaults!.sandbox = { mode: "all" };
      support.getConfig().tools = { fs: { workspaceOnly: true }, deny: ["exec"] };
      await upsertSessionEntryCore(scope, {
        sessionId: sessionKey,
        lifecycleRevision: "native-consent-generation",
        updatedAt: 1,
        label: "Keep this chat",
        providerOverride: nativeModel.provider,
        modelOverride: nativeModel.id,
        agentRuntimeOverride: harness.id,
        permissionMode: "workspace",
        ...entry,
      });
      const before = loadSessionEntry(scope);
      const requestContext = context();
      requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
        catalogSnapshot([nativeModel]),
      );
      support.prepareRuntime.mockResolvedValue({
        kind: "ready",
        runtimeId: harness.id,
        harness,
        validate: () => undefined,
      });
      const patch = {
        key: sessionKey,
        nativeRuntimeConsent: harness.id,
        permissionMode: "full",
        sandboxMode: "off",
        expectedSessionId: sessionKey,
        expectedLifecycleRevision: "native-consent-generation",
        expectedPermissionMode: "workspace",
        expectedSandboxMode: null,
        expectedNativeRuntimeConsent: null,
      };
      return { before, scope, requestContext, patch };
    }

    it.each(["agent", "global"] as const)(
      "persists the exact-runtime grant only in this chat with %s selection defaults",
      async (selectionScope) => {
        const fixture = await prepareConsent();
        support.getConfig().agents!.defaults!.modelSelectionScope = selectionScope;
        const siblingScope = {
          ...fixture.scope,
          sessionKey: `${fixture.scope.sessionKey}:sibling`,
        };
        await upsertSessionEntryCore(siblingScope, {
          sessionId: siblingScope.sessionKey,
          updatedAt: 1,
        });
        const siblingBefore = loadSessionEntry(siblingScope);
        const response = await patchSession(
          {
            ...fixture.patch,
            model: `${nativeModel.provider}/${nativeModel.id}`,
          },
          ["operator.admin"],
          fixture.requestContext,
        );
        expect(response[0]).toBe(true);
        expect(loadSessionEntry(fixture.scope)).toMatchObject({
          label: "Keep this chat",
          sessionId: fixture.patch.expectedSessionId,
          nativeRuntimeConsent: harness.id,
          sandboxMode: "off",
          permissionMode: "full",
        });
        expect(loadSessionEntry(siblingScope)).toEqual(siblingBefore);
        expect(support.configMutationRequested()).toBe(false);
        expect(support.getConfig().agents!.defaults!.sandbox?.mode).toBe("all");
        expect(support.getConfig().tools).toEqual({ fs: { workspaceOnly: true }, deny: ["exec"] });

        expect(
          (
            await patchSession(
              { key: fixture.scope.sessionKey, model: `${nativeModel.provider}/${nativeModel.id}` },
              ["operator.admin"],
              fixture.requestContext,
            )
          )[0],
        ).toBe(true);
        expect(support.configMutationRequested()).toBe(false);
      },
    );

    it.each([{ permissionMode: "guarded" }, { permissionMode: null }, { sandboxMode: null }])(
      "revokes native consent when strengthening or resetting settings %j",
      async (settings) => {
        const fixture = await prepareConsent();
        expect(
          (await patchSession(fixture.patch, ["operator.admin"], fixture.requestContext))[0],
        ).toBe(true);
        expect(
          (
            await patchSession(
              { key: fixture.scope.sessionKey, ...settings },
              ["operator.admin"],
              fixture.requestContext,
            )
          )[0],
        ).toBe(true);
        expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("nativeRuntimeConsent");
        expect(
          (
            await patchSession(
              { key: fixture.scope.sessionKey, permissionMode: "full", sandboxMode: "off" },
              ["operator.admin"],
              fixture.requestContext,
            )
          )[0],
        ).toBe(true);
        const selection = await patchSession(
          { key: fixture.scope.sessionKey, model: `${nativeModel.provider}/${nativeModel.id}` },
          ["operator.admin"],
          fixture.requestContext,
        );
        expect(selection[0]).toBe(false);
        expect(selection[2]).toMatchObject({
          details: {
            code: "AGENT_RUNTIME_RESTRICTED",
            recovery: { expectedNativeRuntimeConsent: null },
          },
        });
        expect(loadSessionEntry(fixture.scope)).not.toHaveProperty("nativeRuntimeConsent");
      },
    );

    it.each<{
      label: string;
      patch?: Record<string, unknown>;
      entry?: Partial<SessionEntry>;
      scopes?: string[];
    }>([
      {
        label: "non-admin",
        scopes: ["operator.write"],
        patch: { permissionMode: undefined, sandboxMode: undefined },
      },
      { label: "stale session", patch: { expectedSessionId: "replaced" } },
      { label: "stale lifecycle", patch: { expectedLifecycleRevision: "replaced" } },
      { label: "missing lifecycle", patch: { expectedLifecycleRevision: undefined } },
      { label: "stale permissions", patch: { expectedPermissionMode: "guarded" } },
      { label: "stale sandbox", patch: { expectedSandboxMode: "off" } },
      { label: "stale consent", patch: { expectedNativeRuntimeConsent: "different-runtime" } },
      { label: "missing consent expectation", patch: { expectedNativeRuntimeConsent: undefined } },
      { label: "another runtime", patch: { nativeRuntimeConsent: "different-runtime" } },
      { label: "mandatory sandbox", entry: { sandbox: "required" } },
      { label: "remote execution", entry: { execHost: "node" } },
      { label: "mandatory execution sandbox", entry: { execHost: "sandbox" } },
    ])("refuses $label without persisting any part of the recovery", async (testCase) => {
      const fixture = await prepareConsent(testCase.entry);
      const response = await patchSession(
        { ...fixture.patch, label: "Must not persist", ...testCase.patch },
        testCase.scopes ?? ["operator.admin"],
        fixture.requestContext,
      );
      expect(response[0]).toBe(false);
      if (testCase.scopes) {
        expect(response[2]).toMatchObject({ message: expect.stringContaining("operator.admin") });
      }
      expect(loadSessionEntry(fixture.scope)).toEqual(fixture.before);
      expect(support.configMutationRequested()).toBe(false);
    });

    it.each(["run-started", "admin-revoked"] as const)(
      "rechecks %s after runtime preparation even when sandbox mode is already off",
      async (change) => {
        const fixture = await prepareConsent({ permissionMode: "full", sandboxMode: "off" });
        const requestClient = client(["operator.admin"]);
        let claim: string | undefined;
        const runId = "native-consent-active-run";
        support.prepareRuntime.mockImplementation(async () => {
          if (change === "admin-revoked") {
            requestClient.connect.scopes = ["operator.write"];
          } else {
            claim = claimAgentRunContext(
              runId,
              { sessionKey: fixture.scope.sessionKey, sessionId: fixture.patch.expectedSessionId },
              { trackOwner: true, ownsContext: true },
            );
          }
          return { kind: "ready", runtimeId: harness.id, harness, validate: () => undefined };
        });
        try {
          const response = await patchSession(
            {
              ...fixture.patch,
              expectedPermissionMode: "full",
              expectedSandboxMode: "off",
            },
            ["operator.admin"],
            fixture.requestContext,
            requestClient,
          );
          expect(response[0]).toBe(false);
          expect(loadSessionEntry(fixture.scope)).toEqual(fixture.before);
        } finally {
          if (claim) {
            releaseAgentRunContext(runId, claim);
          }
        }
      },
    );

    it("accepts a batch consent grant with identity and settings expectations", async () => {
      const fixture = await prepareConsent();
      const {
        key,
        expectedSessionId,
        expectedLifecycleRevision,
        expectedPermissionMode,
        expectedSandboxMode,
        expectedNativeRuntimeConsent,
        ...patch
      } = fixture.patch;
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        req: { type: "req", id: "native-consent-batch", method: "sessions.patchMany" },
        isWebchatConnect: () => true,
        params: {
          targets: [
            {
              key,
              expectedSessionId,
              expectedLifecycleRevision,
              expectedPermissionMode,
              expectedSandboxMode,
              expectedNativeRuntimeConsent,
            },
          ],
          patch,
        },
        client: client(["operator.admin"]),
        context: fixture.requestContext,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, { outcomes: [{ key, ok: true }] }, undefined);
      expect(loadSessionEntry(fixture.scope)?.nativeRuntimeConsent).toBe(harness.id);
    });
  });

  it.each([false, true])(
    "commits model-only native creation only while its owner is current (stale=%s)",
    async (stale) => {
      support.getConfig().tools = { deny: ["browser"] };
      const sessionKey = `agent:main:model-only-${stale}`;
      const requestContext = context();
      requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
        catalogSnapshot([nativeModel]),
      );
      support.prepareRuntime.mockResolvedValue({
        kind: "ready",
        runtimeId: "claude-cli",
        harness: {
          id: "claude-cli",
          label: "Native fixture",
          executionEnvironment: "host-only",
          supports: () => ({ supported: true }),
          runAttempt: vi.fn(),
        },
        validate: vi
          .fn<() => string | undefined>()
          .mockReturnValueOnce(undefined)
          .mockReturnValue(stale ? "Native owner replaced" : undefined),
      });
      const create = createGatewaySession({
        cfg: support.getConfig(),
        key: sessionKey,
        model: "anthropic/claude-sonnet-4-6",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
      });
      if (stale) {
        await expect(create).rejects.toThrow("Native owner replaced");
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
      } else {
        await expect(create).resolves.toMatchObject({ ok: true });
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          agentRuntimeOverride: "claude-cli",
        });
        expect(
          loadSessionEntry({ agentId: "main", sessionKey })?.nativeRuntimeConsent,
        ).toBeUndefined();
      }
    },
  );

  it("retargets queued work and its stored runtime when only a native model is selected", async () => {
    const sessionKey = "agent:main:model-only-patch";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: sessionKey,
        updatedAt: 1,
        agentRuntimeOverride: "openclaw",
        nativeRuntimeConsent: "previous-native-runtime",
      },
    );
    const requestContext = context();
    requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
      catalogSnapshot([nativeModel]),
    );
    support.prepareRuntime.mockResolvedValue({
      kind: "ready",
      runtimeId: "claude-cli",
      validate: () => undefined,
    });
    const queued = await queueRuntimeSelection(sessionKey);
    try {
      expect(
        (
          await patchSession(
            { key: sessionKey, model: "anthropic/claude-sonnet-4-6" },
            ["operator.admin"],
            requestContext,
          )
        )[0],
      ).toBe(true);
      expect(queued).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        agentRuntimeOverride: "claude-cli",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey })).not.toHaveProperty(
        "nativeRuntimeConsent",
      );
    } finally {
      await clearFollowupQueue(sessionKey);
    }
  });
}
