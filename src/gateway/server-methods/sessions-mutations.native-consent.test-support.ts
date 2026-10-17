import { expect, it, vi, type Mock } from "vitest";
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
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const nativeModel: ModelCatalogEntry = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  name: "Native model",
  reasoning: false,
  nativeRuntime: "claude-cli",
};
const nativeHarness: AgentHarness = {
  id: "claude-cli",
  label: "Native fixture",
  executionEnvironment: "host-only",
  supports: () => ({ supported: true }),
  runAttempt: vi.fn(),
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
  queueRuntimeSelection: (sessionKey: string) => { provider: string; model: string };
}): void {
  const { catalogSnapshot, client, context, patchSession, queueRuntimeSelection } = support;
  const selectModel = { model: `${nativeModel.provider}/${nativeModel.id}` };
  const expectPatched = async (
    params: Record<string, unknown>,
    requestContext: GatewayRequestContext,
  ) => {
    expect((await patchSession(params, ["operator.admin"], requestContext))[0]).toBe(true);
  };
  const harness = nativeHarness;
  let nextConsentSession = 0;
  const nativeContext = () => {
    const requestContext = context();
    requestContext.loadGatewayModelCatalogSnapshot.mockResolvedValue(
      catalogSnapshot([nativeModel]),
    );
    return requestContext;
  };
  const createNative = (
    key: string,
    requestContext: GatewayRequestContext,
    options: Partial<Parameters<typeof createGatewaySession>[0]> = {},
  ) =>
    createGatewaySession({
      cfg: support.getConfig(),
      key,
      ...selectModel,
      commandSource: "test",
      operatorRoleActor: { kind: "system" },
      loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
      ...options,
    });

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
    const requestContext = nativeContext();
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
    const run = (
      params: Record<string, unknown>,
      scopes = ["operator.admin"],
      requestClient?: GatewayClient,
    ) => patchSession({ key: sessionKey, ...params }, scopes, requestContext, requestClient);
    const accept = async (params: Record<string, unknown>) =>
      expect((await run(params))[0]).toBe(true);
    const read = () => loadSessionEntry(scope);
    const claim = (runId: string) =>
      claimAgentRunContext(
        runId,
        { sessionKey, sessionId: patch.expectedSessionId },
        { trackOwner: true, ownsContext: true },
      );
    return { before, scope, requestContext, patch, run, accept, read, claim };
  }

  it("persists the exact-runtime grant only in this chat with agent selection defaults", async () => {
    const fixture = await prepareConsent();
    support.getConfig().agents!.defaults!.modelSelectionScope = "agent";
    const siblingScope = {
      ...fixture.scope,
      sessionKey: `${fixture.scope.sessionKey}:sibling`,
    };
    await upsertSessionEntryCore(siblingScope, {
      sessionId: siblingScope.sessionKey,
      updatedAt: 1,
    });
    const siblingBefore = loadSessionEntry(siblingScope);
    await fixture.accept({ ...fixture.patch, ...selectModel });
    expect(fixture.read()).toMatchObject({
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

    await fixture.accept(selectModel);
    expect(support.configMutationRequested()).toBe(false);
  });

  it.each([{ permissionMode: null }, { sandboxMode: null }])(
    "revokes native consent when strengthening or resetting settings %j",
    async (settings) => {
      const fixture = await prepareConsent();
      await fixture.accept(fixture.patch);
      await fixture.accept(settings);
      expect(fixture.read()).not.toHaveProperty("nativeRuntimeConsent");
      await fixture.accept({ permissionMode: "full", sandboxMode: "off" });
      const selection = await fixture.run(selectModel);
      expect(selection[0]).toBe(false);
      expect(selection[2]).toMatchObject({
        details: {
          code: "AGENT_RUNTIME_RESTRICTED",
          recovery: { expectedNativeRuntimeConsent: null },
        },
      });
      expect(fixture.read()).not.toHaveProperty("nativeRuntimeConsent");
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
    const response = await fixture.run(
      { ...fixture.patch, label: "Must not persist", ...testCase.patch },
      testCase.scopes,
    );
    expect(response[0]).toBe(false);
    if (testCase.scopes) {
      expect(response[2]).toMatchObject({ message: expect.stringContaining("operator.admin") });
    }
    expect(fixture.read()).toEqual(fixture.before);
    expect(support.configMutationRequested()).toBe(false);
  });

  it.each(["explicit", "model-only", "create"] as const)(
    "refuses a remembered native permission promotion during an active run (%s)",
    async (kind) => {
      const fixture = await prepareConsent();
      const cfg = support.getConfig();
      cfg.agents!.entries = { main: { nativeRuntimeConsent: [harness.id] } };
      const runId = `remembered-native-${kind}`;
      const claim = fixture.claim(runId);
      try {
        const response =
          kind === "create"
            ? await createNative(fixture.scope.sessionKey, fixture.requestContext, {
                requestingOperatorScopes: ["operator.admin"],
                allowExistingModelSelection: true,
              })
            : await fixture.run(kind === "explicit" ? fixture.patch : selectModel);
        const error = Array.isArray(response)
          ? response[2]
          : response.ok
            ? undefined
            : response.error;
        expect(Array.isArray(response) ? response[0] : response.ok).toBe(false);
        expect(error).toMatchObject({
          message: "Stop the active run before changing this session's execution permissions.",
        });
        expect(fixture.read()).toEqual(fixture.before);
      } finally {
        if (claim) {
          releaseAgentRunContext(runId, claim);
        }
      }
    },
  );

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
          claim = fixture.claim(runId);
        }
        return { kind: "ready", runtimeId: harness.id, harness, validate: () => undefined };
      });
      try {
        const response = await fixture.run(
          {
            ...fixture.patch,
            expectedPermissionMode: "full",
            expectedSandboxMode: "off",
          },
          ["operator.admin"],
          requestClient,
        );
        expect(response[0]).toBe(false);
        expect(fixture.read()).toEqual(fixture.before);
      } finally {
        if (claim) {
          releaseAgentRunContext(runId, claim);
        }
      }
    },
  );

  it.each([false, true])(
    "commits model-only native creation only while its owner is current (stale=%s)",
    async (stale) => {
      support.getConfig().tools = { deny: ["browser"] };
      const sessionKey = `agent:main:model-only-${stale}`;
      const requestContext = nativeContext();
      support.prepareRuntime.mockResolvedValue({
        kind: "ready",
        runtimeId: "claude-cli",
        harness: nativeHarness,
        validate: vi
          .fn<() => string | undefined>()
          .mockReturnValueOnce(undefined)
          .mockReturnValue(stale ? "Native owner replaced" : undefined),
      });
      const create = createNative(sessionKey, requestContext);
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
    const requestContext = nativeContext();
    support.prepareRuntime.mockResolvedValue({
      kind: "ready",
      runtimeId: "claude-cli",
      validate: () => undefined,
    });
    const queued = queueRuntimeSelection(sessionKey);
    try {
      await expectPatched({ key: sessionKey, ...selectModel }, requestContext);
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
      clearFollowupQueue(sessionKey);
    }
  });
}
