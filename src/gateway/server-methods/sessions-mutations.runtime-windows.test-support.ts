import { describe, expect, it, vi } from "vitest";
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
  const { patchSession } = harness;
  describe("runtime-specific session context windows", () => {
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
      return { base, native, snapshot, requestContext };
    }

    it.each(["create", "patch"])(
      "accepts the selected runtime window through %s and projects it after persistence",
      async (operation) => {
        const cfg = harness.getConfig();
        const openClawTestState = harness.getState();
        const sessionKey = `agent:main:runtime-window-${operation}`;
        const { base, native, snapshot, requestContext } = runtimeWindowFixture();
        if (operation === "create") {
          const options = {
            cfg,
            key: sessionKey,
            model: "openai/gpt-5.6-sol",
            agentRuntime: "codex",
            contextWindow: "64k",
            commandSource: "test",
            operatorRoleActor: { kind: "system" as const },
            loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
          };
          expect(await createGatewaySession(options)).toMatchObject({
            ok: true,
            entry: { contextWindow: "64k", agentRuntimeOverride: "codex" },
          });
        } else {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: sessionKey,
              updatedAt: 1,
              providerOverride: "openai",
              modelOverride: "gpt-5.6-sol",
            },
          );
          expect(
            (
              await patchSession(
                {
                  key: sessionKey,
                  model: "openai/gpt-5.6-sol",
                  agentRuntime: "codex",
                  contextWindow: "64k",
                },
                ["operator.admin"],
                requestContext,
              )
            )[0],
          ).toBe(true);
        }
        const stored = loadSessionEntry({ agentId: "main", sessionKey });
        expect(stored).toMatchObject({ contextWindow: "64k", agentRuntimeOverride: "codex" });
        if (!stored) {
          throw new Error("Session was not persisted");
        }
        expect(
          projectSessionPatchResult({
            cfg,
            canonicalKey: sessionKey,
            entry: stored,
            modelCatalog: snapshot.entries,
            modelCatalogRouteVariants: snapshot.routeVariants,
            targetAgentId: "main",
            storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
          }).resolved,
        ).toMatchObject({ contextWindow: "64k", contextWindows: native.contextWindows });
        const row = buildGatewaySessionRow({
          cfg,
          agentId: "main",
          key: sessionKey,
          entry: stored,
          store: { [sessionKey]: stored },
          storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
          modelCatalog: new Map([
            ["main", { entries: snapshot.entries, routeVariants: snapshot.routeVariants }],
          ]),
          lightweightListRow: true,
          skipTranscriptUsageFallback: true,
        });
        expect(row).toMatchObject({
          contextWindow: "64k",
          contextWindows: native.contextWindows,
          contextTokens: 64_000,
        });
        const contextOnly = await patchSession(
          { key: sessionKey, contextWindow: "64k" },
          ["operator.admin"],
          requestContext,
        );
        expect(contextOnly[0]).toBe(true);
        expect(contextOnly[1]).toMatchObject({
          resolved: { contextWindow: "64k", contextWindows: native.contextWindows },
        });
        const invalid = await patchSession(
          { key: sessionKey, contextWindow: "32k" },
          ["operator.admin"],
          requestContext,
        );
        expect(invalid[0]).toBe(false);
        expect(invalid[2]?.message).toContain("use 64k");
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.contextWindow).toBe("64k");
        snapshot.routeVariants = [
          base,
          { ...native, contextWindows: undefined, contextWindowDefault: undefined },
        ];
        const missing = await patchSession(
          { key: sessionKey, contextWindow: "32k" },
          ["operator.admin"],
          requestContext,
        );
        expect(missing[0]).toBe(false);
        expect(missing[2]?.message).not.toContain("use 32k");
        const withoutNativeWindows = projectSessionPatchResult({
          cfg,
          canonicalKey: sessionKey,
          entry: stored,
          modelCatalog: snapshot.entries,
          modelCatalogRouteVariants: snapshot.routeVariants,
          targetAgentId: "main",
          storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
        });
        expect(withoutNativeWindows.resolved?.contextWindows).toBeUndefined();
        expect(
          (
            await patchSession(
              { key: sessionKey, model: "openai/gpt-5.6-sol", agentRuntime: "openclaw" },
              ["operator.admin"],
              requestContext,
            )
          )[0],
        ).toBe(true);
        expect(loadSessionEntry({ agentId: "main", sessionKey })).not.toHaveProperty(
          "contextWindow",
        );
      },
    );
    it.each([50_000, 70_000])(
      "bounds native alternative forks at 64k for a %s-token parent",
      async (parentTokens) => {
        const cfg = harness.getConfig();
        const { snapshot } = runtimeWindowFixture();
        const parentKey = `agent:main:window-parent-${parentTokens}`;
        const childKey = `agent:main:window-child-${parentTokens}`;
        const parent = await createGatewaySession({
          cfg,
          key: parentKey,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
        expect(parent.ok).toBe(true);
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
        const child = await createGatewaySession({
          cfg,
          key: childKey,
          parentSessionKey: parentKey,
          fork: true,
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
          contextWindow: "64k",
          loadGatewayModelCatalogSnapshot: async () => snapshot,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
        if (parentTokens < 64_000) {
          expect(child).toMatchObject({
            ok: true,
            entry: {
              contextWindow: "64k",
              agentRuntimeOverride: "codex",
              forkSource: { sessionKey: parentKey },
            },
          });
        } else {
          expect(child).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("70000/64000 tokens") },
          });
          expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toBeUndefined();
        }
      },
    );
  });
}
