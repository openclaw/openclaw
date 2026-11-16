import { onTestFinished, assert, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { CurrentReadAuthority } from "../../shared/current-read-authority.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { collectForRetentionCheck, expectCollected } from "../../test-utils/retention.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { captureGenerationFacts } from "./chat-metadata-facts.js";
import {
  createChatMetadataModelList,
  resolveSharedModelsListRequest,
} from "./chat-metadata-model-list.js";
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

test.each(["saved-row revision", "sibling session"] as const)(
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
        const catalog = Array.from({ length: 64 }, (_, index) =>
          providerCatalogEntry("test", index === 0 ? "first" : `model-${index}`),
        );
        harness.setOwner({
          ...createChatMetadataOwner(config, "first", {}, "test", "openai-completions"),
          pluginRegistry: createEmptyPluginRegistry(),
          modelCatalog: { entries: catalog, routeVariants: catalog },
        });
        try {
          await harness.refresh();
          using prepare = vi.spyOn(modelLists, "prepareModelsListResult");
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
              const entry = { lifecycleRevision: `revision-${index}` };
              const scope: ChatMetadataReadParams = {
                agentId: "main",
                sessionKey,
                sessionEntry: entry,
                assertCurrent() {
                  assert.strictEqual(scope.sessionEntry, entry);
                },
                isCurrent: () => entry.lifecycleRevision === `revision-${index}`,
              };
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
          // Spy arguments include the original authority; they must not become the retention owner.
          prepare.mockClear();
          await collectForRetentionCheck("equivalent-model-lists", 8);
          const live = (values: WeakRef<object>[]) =>
            values.filter((value) => value.deref()).length;
          expect([
            live(refs.results),
            live(refs.arrays),
            live(refs.rows),
            live(refs.inputs),
          ]).toEqual([1, 1, 64, 0]);
          expect(preparations).toBe(1);
          // Keep the actual cache owner alive throughout collection.
          await harness.refresh();
          expect(prepare).not.toHaveBeenCalled();
        } finally {
          await harness.runtime.stop();
          clearRuntimeConfigSnapshot();
        }
      },
    );
  },
);

test.each(["resolve", "reject"] as const)(
  "does not let an evicted projection %s over its replacement",
  async (settlement) => {
    const agentIds = Array.from({ length: 65 }, (_, index) => `agent-${index}`);
    const harness = createChatMetadataHarness({
      agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const firstError = new Error("evicted projection failed");
    harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
      entered.resolve();
      await release.promise;
      if (settlement === "reject") {
        throw firstError;
      }
      const models = [{ ...facts.modelCatalog.entries[0]!, id: "old", name: "old" }];
      return { modelCatalog: models, models };
    });
    const first = harness.read({ agentId: "agent-0" }).then(
      (value) => value,
      (error: unknown) => error,
    );
    onTestFinished(async () => {
      release.resolve();
      await first;
      await harness.runtime.stop();
    });
    await entered.promise;
    for (const agentId of agentIds.slice(1)) {
      await harness.read({ agentId });
    }
    const replacement = await harness.read({ agentId: "agent-0" });
    release.resolve();
    if (settlement === "reject") {
      expect(await first).toBe(firstError);
    } else {
      expect(await first).toMatchObject({ models: [{ id: "old" }] });
    }
    expect(await harness.startup({ agentId: "agent-0", readPolicy: "ready" })).toMatchObject({
      sessionModelCatalog: replacement.models,
    });
    expect(await harness.read({ agentId: "agent-0" })).toEqual(replacement);
    expect(harness.buildProjection).toHaveBeenCalledTimes(66);
  },
);

test("coalesces stale projection waiters onto the replacement", async () => {
  const harness = createChatMetadataHarness();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const reads: ReturnType<typeof harness.read>[] = [];
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled(reads);
    await harness.runtime.stop();
  });
  await harness.read();
  const previous = await harness.buildProjection.mock.results[0]!.value;
  harness.invalidProjections.add(previous);
  let waiters = 0;
  const withCurrent: CurrentReadAuthority["withCurrent"] = async (consume) => {
    const value = consume();
    if (value === false) {
      if (++waiters === 2) {
        entered.resolve();
      }
      await release.promise;
    }
    return await value;
  };
  reads.push(harness.read({ withCurrent }), harness.read({ withCurrent }));
  await entered.promise;
  release.resolve();
  expect(await Promise.all(reads)).toEqual([await harness.read(), await harness.read()]);
  expect(harness.buildProjection).toHaveBeenCalledTimes(2);
});

test("an evicted model-list rejection preserves the replacement preparation", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "model-list-settlement-" },
    async () => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "test/first" } },
      };
      setRuntimeConfigSnapshot(config);
      const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
      const owner = createChatMetadataOwner(config, "first", {}, "test", "openai-completions");
      harness.setOwner({ ...owner, pluginRegistry: createEmptyPluginRegistry() });
      const lists = createChatMetadataModelList({
        facts: captureGenerationFacts(config),
        context: harness.context,
        maxEntries: 1,
      });
      const params = { agentId: "main", view: "all" as const };
      const saved = resolveSharedModelsListRequest({
        agentId: "main",
        params,
        readScope: { agentId: "main", sessionKey: "agent:main:saved", sessionEntry: {} },
      })!;
      const unscoped = resolveSharedModelsListRequest({ agentId: "main", params })!;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const revoked = new Error("saved-session authority revoked");
      let current = true;
      let firstRead = true;
      const authority: CurrentReadAuthority = {
        async withCurrent(consume) {
          if (firstRead) {
            firstRead = false;
            entered.resolve();
            await release.promise;
          }
          if (!current) {
            throw revoked;
          }
          return await consume();
        },
      };
      using prepare = vi.spyOn(modelLists, "prepareModelsListResult");
      const first = lists.read(saved, undefined, authority).catch((error: unknown) => error);
      try {
        await entered.promise;
        await lists.read(unscoped);
        const replacement = await lists.read(saved);
        current = false;
        release.resolve();
        expect(await first).toBe(revoked);
        expect(await lists.read(saved)).toBe(replacement);
        expect(prepare).toHaveBeenCalledTimes(3);
      } finally {
        release.resolve();
        await first;
        await harness.runtime.stop();
        clearRuntimeConfigSnapshot();
      }
    },
  );
});

test("model-list stale waiters share one successor preparation", async () => {
  const config = { agents: { entries: { main: {} } } };
  const harness = createChatMetadataHarness(config);
  onTestFinished(() => harness.runtime.stop());
  const lists = createChatMetadataModelList({
    facts: captureGenerationFacts(config),
    context: harness.context,
    maxEntries: 1,
  });
  const selection = resolveSharedModelsListRequest({
    agentId: "main",
    params: { view: "all" },
  })!;
  let current = true;
  const previous = { read: () => ({ models: [] }), isCurrent: () => current };
  const next = { read: () => ({ models: [] }), isCurrent: () => true };
  using prepare = vi
    .spyOn(modelLists, "prepareModelsListResult")
    .mockResolvedValue(next)
    .mockResolvedValueOnce(previous);
  expect(await lists.read(selection)).toBe(previous);
  current = false;
  expect(await Promise.all([lists.read(selection), lists.read(selection)])).toEqual([next, next]);
  expect(await lists.read(selection)).toBe(next);
  expect(prepare).toHaveBeenCalledTimes(2);
});

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
        harness.runtime.invalidate();
        // A retained unscoped result cannot satisfy a request declined by the shared owner.
        expect(await read({ agentId: "main" })).toBeUndefined();
        expect(
          await read({ ...saved, sessionEntry: { authProfileOverride: "personal:owner:account" } }),
        ).toBeUndefined();
        expect(prepare).toHaveBeenCalledTimes(5);
      } finally {
        await harness.runtime.stop();
        clearRuntimeConfigSnapshot();
      }
    },
  );
});
