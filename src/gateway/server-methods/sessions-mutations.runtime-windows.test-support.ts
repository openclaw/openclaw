import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  loadSessionEntry,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "../session-create-service.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import { buildGatewaySessionRow } from "../session-utils-row.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function registerSessionRuntimeWindowTests(harness: {
  getConfig: () => OpenClawConfig;
  getState: () => OpenClawTestState;
  patchSession: (
    request: Record<string, unknown>,
    scopes: string[],
    requestContext: Pick<GatewayRequestContext, "loadGatewayModelCatalogSnapshot">,
  ) => Promise<Parameters<RespondFn>>;
}): void {
  const model = "openai/gpt-5.6-sol";
  const selected = { model, agentRuntime: "codex", contextWindow: "64k" };
  function runtimeWindowFixture() {
    const cfg = harness.getConfig();
    const openClawTestState = harness.getState();
    const base: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-5.6-sol",
      name: "Sol",
      reasoning: true,
      contextWindows: [{ id: "32k", label: "32K", contextWindow: 32_000 }],
      contextWindowDefault: "32k",
    };
    const native: ModelCatalogEntry = {
      ...base,
      nativeRuntime: "codex",
      contextWindows: [{ id: "64k", label: "64K", contextWindow: 64_000 }],
      contextWindowDefault: "64k",
    };
    const snapshot = {
      entries: [base],
      routeVariants: [base, native],
      agentId: "main",
      agentDir: openClawTestState.agentDir("main"),
      workspaceDir: openClawTestState.workspaceDir,
      config: cfg,
      catalogComplete: true,
    };
    const requestContext = {
      loadGatewayModelCatalogSnapshot: vi.fn(async () => snapshot),
    };
    const create = (
      options: Omit<
        Parameters<typeof createGatewaySession>[0],
        "cfg" | "commandSource" | "operatorRoleActor"
      >,
    ) =>
      createGatewaySession({
        cfg,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        ...options,
      });
    return { base, native, snapshot, requestContext, cfg, create };
  }

  it("accepts the selected runtime window through patch and projects it after persistence", async () => {
    const sessionKey = "agent:main:runtime-window-patch";
    const { base, native, snapshot, requestContext, cfg } = runtimeWindowFixture();
    const scope = { agentId: "main", sessionKey };
    const patch = (params: Record<string, unknown>) =>
      harness.patchSession({ key: sessionKey, ...params }, ["operator.admin"], requestContext);
    await upsertSessionEntryCore(scope, {
      sessionId: sessionKey,
      updatedAt: 1,
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    expect((await patch(selected))[0]).toBe(true);
    const stored = loadSessionEntry(scope);
    expect(stored).toMatchObject({ contextWindow: "64k", agentRuntimeOverride: "codex" });
    if (!stored) {
      throw new Error("Session was not persisted");
    }
    const storePath = harness.getState().statePath("agents", "main", "sessions", "sessions.json");
    const projection = { cfg, entry: stored, storePath };
    const project = () =>
      projectSessionPatchResult({
        ...projection,
        preparedAcpMeta: null,
        canonicalKey: sessionKey,
        modelCatalog: snapshot.entries,
        modelCatalogRouteVariants: snapshot.routeVariants,
        targetAgentId: "main",
      }).resolved;
    const window = { contextWindow: "64k", contextWindows: native.contextWindows };
    expect(project()).toMatchObject(window);
    const row = buildGatewaySessionRow({
      ...projection,
      agentId: "main",
      key: sessionKey,
      store: { [sessionKey]: stored },
      modelCatalog: new Map([
        ["main", { entries: snapshot.entries, routeVariants: snapshot.routeVariants }],
      ]),
      lightweightListRow: true,
    });
    expect(row).toMatchObject({ ...window, contextTokens: 64_000 });
    const contextOnly = await patch({ contextWindow: "64k" });
    expect(contextOnly[0]).toBe(true);
    expect(contextOnly[1]).toMatchObject({ resolved: window });
    const invalid = await patch({ contextWindow: "32k" });
    expect(invalid[0]).toBe(false);
    expect(invalid[2]?.message).toContain("use 64k");
    expect(loadSessionEntry(scope)?.contextWindow).toBe("64k");
    snapshot.routeVariants = [
      base,
      { ...native, contextWindows: undefined, contextWindowDefault: undefined },
    ];
    const missing = await patch({ contextWindow: "32k" });
    expect(missing[0]).toBe(false);
    expect(missing[2]?.message).not.toContain("use 32k");
    expect(project()?.contextWindows).toBeUndefined();
    expect((await patch({ model, agentRuntime: "openclaw" }))[0]).toBe(true);
    expect(loadSessionEntry(scope)).not.toHaveProperty("contextWindow");
  });
  it("bounds native alternative forks at 64k for a 70000-token parent", async () => {
    const parentTokens = 70_000;
    const { snapshot, create } = runtimeWindowFixture();
    const parentKey = `agent:main:window-parent-${parentTokens}`;
    const childKey = `agent:main:window-child-${parentTokens}`;
    expect((await create({ key: parentKey })).ok).toBe(true);
    const scope = { agentId: "main", sessionKey: parentKey };
    const stored = loadSessionEntry(scope);
    if (!stored) {
      throw new Error("Parent was not persisted");
    }
    appendTranscriptMessageSync(
      { ...scope, sessionId: stored.sessionId },
      { message: { role: "user", content: "Context-window fork fixture", timestamp: 1 } },
    );
    await upsertSessionEntryCore(scope, {
      ...stored,
      totalTokens: parentTokens,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    });
    const child = await create({
      key: childKey,
      parentSessionKey: parentKey,
      fork: true,
      ...selected,
      loadGatewayModelCatalogSnapshot: async () => snapshot,
    });
    expect(child).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("70000/64000 tokens") },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toBeUndefined();
  });
}
