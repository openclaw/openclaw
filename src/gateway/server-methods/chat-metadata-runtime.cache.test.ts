import { onTestFinished, assert, expect, test, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { collectForRetentionCheck, expectCollected } from "../../test-utils/retention.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";
import * as modelLists from "./models-list-result.js";
import { providerCatalogEntry } from "./models-list-result.openai-routes.test-support.js";

test("rejects a retired owner instead of retrying compact metadata indefinitely", async () => {
  const config = { agents: { entries: { main: {} } } };
  const harness = createChatMetadataHarness(config);
  onTestFinished(() => harness.runtime.stop());
  const isCurrent = vi.fn(() => true);
  harness.setOwner({ ...createChatMetadataOwner(config, "retired"), isCurrent });
  await harness.refresh();
  await harness.read({ includeModels: false });
  // Bound the regression's microtask loop without a real timer.
  isCurrent
    .mockClear()
    .mockReturnValueOnce(false)
    .mockImplementation(() => assert.fail("Compact metadata repeatedly read a retired owner"));
  await expect(harness.read({ includeModels: false })).rejects.toThrow(
    'prepared chat metadata owner retired for agent "main"',
  );
  expect(isCurrent).toHaveBeenCalledOnce();
});

test("projects each session's account provenance when metadata reuses its catalog", async () => {
  const harness = createChatMetadataHarness();
  onTestFinished(() => harness.runtime.stop());
  await harness.refresh();
  const id = "test:shared";
  for (const source of ["user", "user-link", "user"] as const) {
    const sessionEntry = { authProfileOverride: id, authProfileOverrideSource: source };
    const { accountSelection } = await harness.read({ sessionEntry });
    expect(accountSelection).toEqual({ kind: "shared", authProfileId: id, label: id, source });
  }
  expect(harness.buildProjection).toHaveBeenCalledOnce();
});

test("reads shared auth once per fleet check and observes the next mutation", async () => {
  const agentIds = ["main", "second", "third", "custom"];
  const config = { agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) } };
  const harness = createChatMetadataHarness(config);
  onTestFinished(() => harness.runtime.stop());
  const owners = new Map(
    agentIds.map((id) => [
      id,
      {
        ...createChatMetadataOwner(config, id),
        ...(id === "custom" ? { inheritedAuthDir: "/tmp/custom-inherited" } : {}),
      },
    ]),
  );
  harness.getPreparedOwner.mockImplementation((params) => owners.get(params?.agentId ?? "main"));
  const revisions = new Map<string | undefined, number>();
  harness.getAuthStoreRevision.mockImplementation((dir) => revisions.get(dir) ?? 0);
  await harness.refresh();
  const initial = JSON.stringify(await harness.read());
  const readWarm = async () => {
    harness.getAuthStoreRevision.mockClear();
    expect(JSON.stringify(await harness.read())).toBe(initial);
    expect(
      harness.getAuthStoreRevision.mock.calls.filter(([dir]) => dir === undefined),
    ).toHaveLength(1);
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/custom-inherited");
  };
  await readWarm();
  for (const dir of [undefined, "/tmp/custom-inherited", owners.get("second")!.agentDir]) {
    const preparations = harness.buildProjection.mock.calls.length;
    revisions.set(dir, 1);
    expect(JSON.stringify(await harness.read())).toBe(initial);
    expect(harness.buildProjection).toHaveBeenCalledTimes(preparations + 1);
    await readWarm();
  }
});

test.each(["neutral", "profile"] as const)(
  "releases session entries after caching a %s catalog",
  async (variant) => {
    class SessionInput {
      authProfileOverride = variant === "profile" ? "test:shared" : undefined;
    }
    const control = new WeakRef({});
    const harness = createChatMetadataHarness();
    onTestFinished(() => harness.runtime.stop());
    await harness.refresh();
    const { metadata, sessionEntry } = await (async () => {
      const entry = new SessionInput();
      return {
        metadata: await harness.read({ sessionEntry: entry }),
        sessionEntry: new WeakRef(entry),
      };
    })();
    await expectCollected(sessionEntry, control);
    expect(await harness.read()).toMatchObject({ models: metadata.models });
    expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
  },
);

test("bounds retained commands and neutral projections instead of warming the fleet", async () => {
  const agentIds = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
  const harness = createChatMetadataHarness({
    agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  });
  onTestFinished(() => harness.runtime.stop());
  await harness.refresh();
  expect(harness.buildCommands).not.toHaveBeenCalled();
  expect(harness.buildProjection).not.toHaveBeenCalled();
  for (const readPolicy of ["current", "ready"] as const) {
    await expect(harness.startup({ agentId: "agent-0", readPolicy })).resolves.toBeUndefined();
  }
  expect(harness.buildProjection).not.toHaveBeenCalled();

  const first = await harness.runtime.read({ agentId: "agent-0" });
  expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
  expect(harness.buildCommands).toHaveBeenCalledOnce();
  expect(harness.buildProjection).toHaveBeenCalledOnce();
  for (const agentId of agentIds.slice(1)) {
    await harness.runtime.read({ agentId });
  }
  expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length);
  expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);
  const retained: string[] = [];
  for (const agentId of agentIds) {
    if (await harness.startup({ agentId, readPolicy: "ready" })) {
      retained.push(agentId);
    }
  }
  expect(retained).toEqual(agentIds.slice(-64));
  expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length);

  expect(await harness.runtime.read({ agentId: "agent-0" })).toEqual(first);
  expect(harness.buildCommands).toHaveBeenCalledTimes(agentIds.length + 1);
  expect(harness.buildProjection).toHaveBeenCalledTimes(agentIds.length + 1);
});

test.each([
  "saved-row revision",
  "sibling session",
  "cold shared pin",
  "published shared pin",
] as const)(
  "retains one model list across equivalent %s reads while releasing request inputs",
  async (variant) => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "model-list-retention-" },
      async () => {
        const config: OpenClawConfig = {
          agents: {
            entries: { main: {} },
            defaults: { model: "test/first", modelPolicy: { allow: ["test/*"] } },
          },
        };
        setRuntimeConfigSnapshot(config);
        const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
        const shared = variant === "cold shared pin" || variant === "published shared pin";
        const retirement = new AbortController();
        const accountCatalog = shared
          ? createPreparedAccountCatalogAccess(() => true, retirement.signal)
          : undefined;
        const credential = { type: "api_key", provider: "test", key: "synthetic-key" } as const;
        if (shared) {
          harness.setAuthStore({ version: 1, profiles: { "test:shared": credential } });
        }
        const catalog = Array.from({ length: 64 }, (_, index) =>
          providerCatalogEntry("test", index === 0 ? "first" : `model-${index}`),
        );
        harness.setOwner({
          ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
          pluginRegistry: createEmptyPluginRegistry(),
          modelCatalog: { entries: catalog, routeVariants: catalog },
          accountCatalog,
        });
        try {
          if (variant === "published shared pin") {
            const published = await accountCatalog!.acquire({
              profileId: "test:shared",
              credential,
              allowDiscovery: true,
              load: async () => [{ provider: "test", profileId: "test:shared", status: "ready" }],
            });
            expect(published.hasPublishedCatalog).toBe(true);
          }
          await harness.refresh();
          using prepare = vi.spyOn(modelLists, "prepareModelsListResult");
          using acquire = accountCatalog ? vi.spyOn(accountCatalog, "acquire") : undefined;
          const refs = await (async () => {
            const results: WeakRef<object>[] = [];
            const arrays: WeakRef<object>[] = [];
            const rows: WeakRef<object>[] = [];
            const inputs: WeakRef<object>[] = [];
            const seen = new WeakSet<object>();
            const track = (value: object, target: WeakRef<object>[]) => {
              if (!seen.has(value)) {
                seen.add(value);
                target.push(new WeakRef(value));
              }
            };
            let expected: string | undefined;
            for (let index = 0; index < 64; index++) {
              const sessionKey = `agent:main:shared:${variant === "sibling session" ? index : 0}`;
              const entry = {
                lifecycleRevision: `revision-${index}`,
                ...(shared && { authProfileOverride: "test:shared" }),
              };
              const scope: ChatMetadataReadParams = {
                agentId: "main",
                sessionKey,
                sessionEntry: entry,
                assertCurrent() {
                  assert.strictEqual(scope.sessionEntry, entry);
                },
                isCurrent: () => entry.lifecycleRevision === `revision-${index}`,
              };
              if (shared) {
                scope.withCurrent = async <T>(consume: () => T): Promise<Awaited<T>> => {
                  scope.assertCurrent?.();
                  return await consume();
                };
              }
              const result = await harness.runtime.readModelsList({
                agentId: "main",
                params: { agentId: "main", view: "all", sessionKey },
                readScope: scope,
                includeManualSelection: true,
              });
              assert.isDefined(result);
              expect(result.models).toHaveLength(64);
              expected ??= JSON.stringify(result);
              expect(JSON.stringify(result)).toBe(expected);
              track(result, results);
              track(result.models, arrays);
              for (const row of result.models) {
                track(row, rows);
              }
              inputs.push(new WeakRef(entry), new WeakRef(scope));
            }
            return { results, arrays, rows, inputs };
          })();
          const preparations = prepare.mock.calls.length;
          const accountAcquisitions = acquire?.mock.calls.length;
          // Spy arguments include the original authority; they must not become the retention owner.
          prepare.mockClear();
          acquire?.mockClear();
          if (shared) {
            expect(accountAcquisitions).toBeGreaterThan(0);
          }
          await collectForRetentionCheck("equivalent-model-lists", 8);
          const live = (values: WeakRef<object>[]) =>
            values.filter((value) => value.deref()).length;
          expect(
            [live(refs.results), live(refs.arrays), live(refs.rows), live(refs.inputs)],
            `Surviving input indices: ${refs.inputs
              .flatMap((value, index) => (value.deref() ? [index] : []))
              .join(",")}`,
          ).toEqual([1, 1, 64, 0]);
          expect(preparations).toBe(1);
          // Keep the actual cache owner alive throughout collection.
          await harness.refresh();
          expect(prepare).not.toHaveBeenCalled();
        } finally {
          retirement.abort();
          await harness.runtime.stop();
          clearRuntimeConfigSnapshot();
        }
      },
    );
  },
);

test("keeps saved-selection presence and zero compaction provenance distinct", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "model-list-selection-" },
    async () => {
      const config = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      harness.setOwner({
        ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
        pluginRegistry: createEmptyPluginRegistry(),
      });
      const read = (readScope?: ChatMetadataReadParams) =>
        harness.runtime.readModelsList({
          agentId: "main",
          params: {
            view: "all",
            ...(readScope?.sessionKey ? { sessionKey: readScope.sessionKey } : {}),
          },
          readScope,
          includeManualSelection: true,
        });
      const saved = { agentId: "main", sessionKey: "agent:main:saved" };
      try {
        await harness.refresh();
        using prepare = vi.spyOn(modelLists, "prepareModelsListResult");
        expect((await read())?.accountSelection).toBeUndefined();
        expect((await read(saved))?.accountSelection?.kind).toBe("automatic");
        expect((await read({ ...saved, sessionEntry: {} }))?.accountSelection?.kind).toBe(
          "automatic",
        );
        expect(prepare).toHaveBeenCalledTimes(3);
        for (const count of [undefined, 0] as const) {
          const result = await read({
            ...saved,
            sessionEntry: {
              authProfileOverride: "test:shared",
              authProfileOverrideCompactionCount: count,
            },
          });
          expect(result?.accountSelection).toMatchObject({
            kind: "shared",
            authProfileId: "test:shared",
            source: count === undefined ? "user" : "auto",
          });
        }
        expect(prepare).toHaveBeenCalledTimes(5);
        const personalProfileId = `personal:${GATEWAY_OWNER_PROFILE_ID}:00000000-0000-4000-8000-000000000001`;
        expect(isUserModelAuthProfileId(personalProfileId)).toBe(true);
        harness.runtime.invalidate();
        // A retained unscoped result cannot satisfy a request declined by the shared owner.
        expect(await read({ agentId: "main" })).toBeUndefined();
        expect(
          await read({ ...saved, sessionEntry: { authProfileOverride: personalProfileId } }),
        ).toBeUndefined();
        expect(prepare).toHaveBeenCalledTimes(5);
      } finally {
        await harness.runtime.stop();
        clearRuntimeConfigSnapshot();
      }
    },
  );
});
