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
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "../session-create-service.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

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
  const harness = nativeHarness;
  const nativeSelection = {
    providerOverride: "anthropic",
    modelOverride: "claude-sonnet-4-6",
    agentRuntimeOverride: "claude-cli",
  };
  const readyRuntime = (validate: () => string | undefined = () => undefined) => ({
    kind: "ready" as const,
    runtimeId: harness.id,
    harness,
    validate,
  });
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
    const { scope, seed, read } = sessionMutationFixture(sessionKey);
    support.getConfig().agents!.defaults!.sandbox = { mode: "all" };
    support.getConfig().tools = { fs: { workspaceOnly: true }, deny: ["exec"] };
    await seed({
      lifecycleRevision: "native-consent-generation",
      label: "Keep this chat",
      ...nativeSelection,
      permissionMode: "workspace",
      ...entry,
    });
    const before = read();
    const requestContext = nativeContext();
    support.prepareRuntime.mockResolvedValue(readyRuntime());
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
    const claim = (runId: string) =>
      claimAgentRunContext(
        runId,
        { sessionKey, sessionId: patch.expectedSessionId },
        { trackOwner: true, ownsContext: true },
      );
    return { before, scope, requestContext, patch, run, accept, read, claim };
  }

  it("grants consent only to this chat with agent defaults", async () => {
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
    "revokes consent when settings reset: %j",
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

  it.each([
    { kind: "explicit", phase: "active" },
    { kind: "model-only", phase: "active" },
    { kind: "create", phase: "active" },
    { kind: "explicit", phase: "run-started" },
    { kind: "explicit", phase: "admin-revoked" },
  ])("rejects native promotion: $kind/$phase", async ({ kind, phase }) => {
    const late = phase !== "active";
    const fullAccess = { permissionMode: "full", sandboxMode: "off" } as const;
    const fixture = await prepareConsent(late ? fullAccess : {});
    const requestClient = client(["operator.admin"]);
    const runId = `native-consent-${kind}-${phase}`;
    let claim: string | undefined;
    const revoke = () => {
      if (phase === "admin-revoked") {
        requestClient.connect.scopes = ["operator.write"];
      } else {
        claim = fixture.claim(runId);
      }
    };
    if (late) {
      support.prepareRuntime.mockImplementation(async () => {
        revoke();
        return readyRuntime();
      });
    } else {
      support.getConfig().agents!.entries = { main: { nativeRuntimeConsent: [harness.id] } };
      revoke();
    }
    try {
      const response =
        kind === "create"
          ? await createNative(fixture.scope.sessionKey, fixture.requestContext, {
              requestingOperatorScopes: ["operator.admin"],
              allowExistingModelSelection: true,
            })
          : await fixture.run(
              kind === "model-only"
                ? selectModel
                : {
                    ...fixture.patch,
                    ...(late ? { expectedPermissionMode: "full", expectedSandboxMode: "off" } : {}),
                  },
              ["operator.admin"],
              requestClient,
            );
      expect(Array.isArray(response) ? response[0] : response.ok).toBe(false);
      if (!late) {
        const error = Array.isArray(response)
          ? response[2]
          : response.ok
            ? undefined
            : response.error;
        expect(error).toMatchObject({
          message: "Stop the active run before changing this session's execution permissions.",
        });
      }
      expect(fixture.read()).toEqual(fixture.before);
    } finally {
      if (claim) {
        releaseAgentRunContext(runId, claim);
      }
    }
  });

  it.each([false, true])("requires a current native owner on create (stale=%s)", async (stale) => {
    support.getConfig().tools = { deny: ["browser"] };
    const sessionKey = `agent:main:model-only-${stale}`;
    const requestContext = nativeContext();
    support.prepareRuntime.mockResolvedValue(
      readyRuntime(
        vi
          .fn<() => string | undefined>()
          .mockReturnValueOnce(undefined)
          .mockReturnValue(stale ? "Native owner replaced" : undefined),
      ),
    );
    const create = createNative(sessionKey, requestContext);
    if (stale) {
      await expect(create).rejects.toThrow("Native owner replaced");
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
    } else {
      await expect(create).resolves.toMatchObject({ ok: true });
      const stored = loadSessionEntry({ agentId: "main", sessionKey });
      expect(stored).toMatchObject(nativeSelection);
      expect(stored?.nativeRuntimeConsent).toBeUndefined();
    }
  });

  it("retargets queued work on native model selection", async () => {
    const sessionKey = "agent:main:model-only-patch";
    const { seed, read } = sessionMutationFixture(sessionKey);
    await seed({
      agentRuntimeOverride: "openclaw",
      nativeRuntimeConsent: "previous-native-runtime",
    });
    const requestContext = nativeContext();
    support.prepareRuntime.mockResolvedValue({
      kind: "ready",
      runtimeId: "claude-cli",
      validate: () => undefined,
    });
    const queued = queueRuntimeSelection(sessionKey);
    try {
      const response = await patchSession(
        { key: sessionKey, ...selectModel },
        ["operator.admin"],
        requestContext,
      );
      expect(response[0]).toBe(true);
      expect(queued).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
      const stored = read();
      expect(stored).toMatchObject(nativeSelection);
      expect(stored).not.toHaveProperty("nativeRuntimeConsent");
    } finally {
      clearFollowupQueue(sessionKey);
    }
  });
}

export function startSessionMutationRequest(
  method: string,
  params: Record<string, unknown>,
  options: Pick<GatewayRequestHandlerOptions, "client" | "context"> &
    Partial<GatewayRequestHandlerOptions>,
) {
  const respond = vi.fn<RespondFn>(options.respond);
  const handler = (method === "sessions.create" ? sessionCreateHandlers : sessionMutationHandlers)[
    method
  ]!;
  const running = Promise.resolve(
    handler({
      req: { type: "req", id: method, method, params },
      isWebchatConnect: () => true,
      ...options,
      params,
      respond,
    }),
  );
  return { respond, responses: respond.mock.calls, running };
}

export function createSessionMutationCatalog(
  config: OpenClawConfig,
  state: Pick<OpenClawTestState, "agentDir" | "workspaceDir">,
  entries: ModelCatalogEntry[],
  routeVariants = entries,
) {
  return {
    config,
    entries,
    routeVariants,
    agentId: "main",
    agentDir: state.agentDir("main"),
    workspaceDir: state.workspaceDir,
    catalogComplete: true,
  };
}

export function createSessionMutationContext(
  config: OpenClawConfig = {},
  loadCatalog?: GatewayRequestContext["loadGatewayModelCatalog"],
  cron?: Pick<
    GatewayRequestContext["cron"],
    "list" | "updateWithPrecondition" | "getDefaultAgentId"
  >,
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: vi.fn(
      async (params: Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0]) => {
        const entries = loadCatalog ? await loadCatalog(params) : [];
        return { entries, routeVariants: entries };
      },
    ),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    dedupe: new Map(),
    ...(cron ? { cron } : {}),
  } as unknown as GatewayRequestContext;
}

export function sessionMutationFixture(sessionKey: string, agentId = "main") {
  const scope = { agentId, sessionKey };
  return {
    scope,
    read: () => loadSessionEntry(scope),
    seed: (entry: Partial<SessionEntry> = {}) =>
      upsertSessionEntryCore(scope, { sessionId: sessionKey, updatedAt: 1, ...entry }),
  };
}
