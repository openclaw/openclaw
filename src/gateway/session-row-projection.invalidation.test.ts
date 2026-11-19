import { describe, afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { setRuntimeConfigSnapshot, resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  identifiedClient,
  listSessions,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

describe("session model projection retained boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  it("indexes and filters the causal creator without publishing its isolation actor", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const causal = ensureProfileForEmail("causal@example.test");
      const legacy = ensureProfileForEmail("isolation@example.test");
      const key = "agent:main:dashboard:creator-projection";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "creator-projection",
          updatedAt: 1,
          createdVia: "spawn",
          createdActor: {
            type: "human",
            source: "profile",
            id: legacy.id,
            delegatedBy: { type: "human", source: "profile", id: causal.id },
          },
        },
      );
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const result = await listProjectedSessions({ projection, opts: { creatorId: causal.id } });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.createdActor?.id).toBe(causal.id);
      expect(result.sessions[0]?.owner?.actor.id).toBe(causal.id);
      expect(JSON.stringify(result.sessions[0])).not.toContain(legacy.id);
      expect(projection.listCreatedActors().map((actor) => actor.id)).toContain(causal.id);
      expect(projection.listCreatedActors().map((actor) => actor.id)).not.toContain(legacy.id);
      const other = await listProjectedSessions({ projection, opts: { creatorId: legacy.id } });
      expect(other.sessions).toHaveLength(0);
    });
  });
  it("adopts changed model normalization after a manifest publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const baseConfig: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "example/list-alias" } },
        plugins: { entries: { "synthetic-hooks": { enabled: true } } },
      };
      const cfg = baseConfig;
      setRuntimeConfigSnapshot(cfg);
      const keys = Array.from({ length: 1 }, (_, index) => `agent:main:plugin-reload-${index}`);
      for (const [index, sessionKey] of keys.entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          { sessionId: `plugin-reload-${index}`, updatedAt: index + 1, visibility: "shared" },
        );
      }
      const instances: PluginInstance[] = [];
      const view = (model: string, sourceDigest = "original-code") => {
        const owner = new PluginInstance("model-owner");
        owner.sourceDigest = sourceDigest;
        instances.push(owner);
        const pluginRegistry = createEmptyPluginRegistry();
        pluginRegistry.providers.push({
          pluginId: "model-owner",
          source: "/tmp/model-owner/index.js",
          provider: owner.wrap({
            id: "example",
            label: "Example",
            auth: [],
            resolveThinkingProfile: () => null,
          }),
        });
        const metadataSnapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            { id: "synthetic-hooks", hooks: ["before_prompt_build"] },
            {
              id: "model-owner",
              origin: "global",
              providers: ["example"],
              modelIdNormalization: {
                providers: { example: { aliases: { "list-alias": model } } },
              },
            },
          ],
        });
        const entries = [
          { provider: "example", id: "original", name: "Original" },
          { provider: "example", id: "replacement", name: "Replacement" },
        ];
        const prepared: ModelCatalogSnapshot = { entries, routeVariants: entries };
        prepareModelCatalogThinkingPolicies({
          catalog: prepared,
          metadataSnapshot,
          pluginRegistry,
        });
        return new Map([
          [
            "main",
            createPreparedGatewayModelCatalog({
              config: cfg,
              entries: prepared.entries,
              routeVariants: prepared.routeVariants,
              pluginRegistry,
              metadataSnapshot,
            }),
          ],
        ]);
      };
      let catalog = view("original");
      using release = holdForeground();
      using projection = await createTestProjection({
        cfg,
        getConfig: () => cfg,
        getModelCatalog: async () => catalog,
      });
      const list = () => listProjectedSessions({ projection, opts: {} });
      try {
        expect((await list()).sessions.map((row) => row.model)).toEqual(["original"]);
        catalog = view("replacement");
        notifyPreparedModelRuntimePublication({ phase: "published" });
        await projection.ensureMaterialized();
        expect((await list()).sessions.map((row) => row.model)).toEqual(["replacement"]);
      } finally {
        await projection.ensureMaterialized();
        projection.dispose();
        release();
        resetConfigRuntimeState();
        await Promise.all(instances.map((instance) => instance.dispose()));
      }
    });
  });
  it("keeps inherited model selection current after reparenting and parent deletion", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(Date, "now").mockReturnValue(100);
      const cfg = {
        agents: {
          entries: { main: {} },
          defaults: { model: "unit-test/default" },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const parentKey = "agent:main:discord:channel:parent";
      const children = ["agent:main:child", `${parentKey}:thread:child`];
      const siblingKey = "agent:main:sibling";
      const scope = { agentId: "main", sessionKey: parentKey };
      const parent: SessionEntry = {
        sessionId: "parent",
        updatedAt: 1,
        visibility: "shared",
        providerOverride: "unit-test",
        modelOverride: "selected",
        modelOverrideSource: "user",
      };
      replaceSessionEntrySync(scope, { ...parent });
      for (const [index, sessionKey] of [...children, siblingKey].entries()) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: `child-${index}`,
            updatedAt: index + 2,
            visibility: "shared",
            ...(sessionKey === children[0] ? { parentSessionKey: parentKey } : {}),
          },
        );
      }
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const client = identifiedClient("viewer");
      const list = () => listSessions({ context, client, request: {} });
      try {
        const initial = await list();
        expect(initial.totalCount).toBe(4);
        expect(initial.sessions.map((row) => row.key)).toEqual([
          siblingKey,
          children[1],
          children[0],
          parentKey,
        ]);
        expect(initial.sessions.find((row) => row.key === parentKey)?.childSessions).toEqual([
          children[0],
        ]);
        const cases: Array<[Partial<SessionEntry>, string, string]> = [
          [{ providerOverride: "other-test" }, "other-test", "selected"],
          [{ modelOverride: "changed" }, "other-test", "changed"],
          [{ modelOverrideSource: "default" }, "unit-test", "default"],
          [
            {
              modelOverrideSource: "auto",
              modelOverrideFallbackOriginProvider: "other-test",
              modelOverrideFallbackOriginModel: "changed",
            },
            "other-test",
            "changed",
          ],
          [{ modelOverrideFallbackOriginModel: "original" }, "unit-test", "default"],
          [
            {
              modelOverrideFallbackOriginModel: "changed",
              modelOverrideFallbackOriginProvider: "original-test",
            },
            "unit-test",
            "default",
          ],
        ];
        for (const [change, provider, model] of cases) {
          Object.assign(parent, change);
          replaceSessionEntrySync(scope, { ...parent });
          const result = await list();
          for (const key of children) {
            expect(result.sessions.find((row) => row.key === key)).toMatchObject({
              modelProvider: provider,
              model,
            });
          }
        }
        parent.modelOverrideSource = "user";
        replaceSessionEntrySync(scope, { ...parent });
        const pinned = await list();
        for (const key of children) {
          expect(pinned.sessions.find((row) => row.key === key)?.model).toBe("changed");
        }
        const childScope = { agentId: "main", sessionKey: children[0]! };
        replaceSessionEntrySync(childScope, {
          ...loadSessionEntry(childScope)!,
          parentSessionKey: siblingKey,
        });
        const moved = await list();
        expect(moved.totalCount).toBe(4);
        expect(moved.sessions.find((row) => row.key === parentKey)?.childSessions).toBeUndefined();
        expect(moved.sessions.find((row) => row.key === siblingKey)?.childSessions).toEqual([
          children[0],
        ]);
        expect(moved.sessions.find((row) => row.key === children[0])?.model).toBe("default");
        await deleteSessionEntryLifecycle({
          ...scope,
          storePath: projection.capture({ agentId: "main", key: parentKey })!.storeTarget.storePath,
          archiveTranscript: false,
          target: { canonicalKey: parentKey, storeKeys: [parentKey] },
        });
        const deleted = await list();
        expect(deleted.sessions.some((row) => row.key === parentKey)).toBe(false);
        expect(deleted.sessions.filter((row) => children.includes(row.key))).toEqual(
          expect.arrayContaining(
            children.map((key) => expect.objectContaining({ key, model: "default" })),
          ),
        );
      } finally {
        await projection.ensureMaterialized();
      }
    });
  });
});
