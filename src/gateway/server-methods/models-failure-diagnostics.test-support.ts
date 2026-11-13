import { vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/model-catalog.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";

type Fact = Record<string, string | number | boolean>;

export function createModelListFailureDiagnostics() {
  const events: Fact[] = [];
  const restores: Array<() => void> = [];
  const identities = new WeakMap<object, number>();
  const retained = new WeakSet<ModelsListResult>();
  const bindings = new WeakMap<ModelsListResult, Fact>();
  const wrappedProjections = new WeakSet<object>();
  let nextIdentity = 0;
  let active = false;
  let truncated = false;
  let factories = 0;
  let notifications = 0;
  let consumers = 0;
  let observerFailed = false;
  const record = (operation: () => void) => {
    try {
      operation();
    } catch {
      observerFailed = true;
    }
  };
  const identity = (value: object) => {
    let ordinal = identities.get(value);
    if (ordinal === undefined) {
      ordinal = ++nextIdentity;
      identities.set(value, ordinal);
    }
    return ordinal;
  };
  const note = (event: Fact) =>
    record(() => {
      if (!active) {
        return;
      }
      if (events.length < 128) {
        events.push(event);
      } else {
        truncated = true;
      }
    });
  const oldRow = (rows: readonly { provider: string; id: string }[]) =>
    rows.some((row) => row.provider === "opencode" && row.id === "account-a-only");
  const account = (store: AuthProfileStore) => {
    let first = false;
    let replacement = false;
    for (const profile of Object.values(store.profiles)) {
      if (profile.provider !== "opencode" || profile.type !== "api_key") {
        continue;
      }
      first ||= profile.key === "account-a-key";
      replacement ||= profile.key === "account-b-key";
    }
    return first && replacement ? "mixed" : first ? "first" : replacement ? "replacement" : "other";
  };
  const observe = <T extends ModelsListResult | undefined>(branch: string, pending: Promise<T>) => {
    note({ branch: `${branch}-enter` });
    // Observe settlement without replacing the owner's promise or adding an awaited operation.
    void pending.then(
      (result) =>
        record(() =>
          note({
            branch: `${branch}-result`,
            present: result !== undefined,
            result: result ? identity(result) : 0,
            ...(result && bindings.get(result)),
            retained: result !== undefined && retained.has(result),
            oldRow: result !== undefined && oldRow(result.models),
          }),
        ),
      () => record(() => note({ branch: `${branch}-rejected` })),
    );
    return pending;
  };
  return {
    note,
    observeRpcList: (pending: Promise<ModelsListResult>) => observe("rpc-list", pending),
    begin: () => {
      active = true;
    },
    async install() {
      // Install after fixture state/config/auth exist, before the lazy Gateway startup.
      const runtimeModule = await import("./chat-metadata-runtime.js");
      const retainedModule = await import("./chat-metadata-model-list.js");
      const resultModule = await import("./models-list-result.js");
      const sharedModule = await import("./prepared-read.js");
      const authModule = await import("../../agents/auth-profiles/runtime-snapshots.js");
      restores.push(
        authModule.registerRuntimeAuthProfileStoreMutationListener((event) => {
          notifications += 1;
          note({
            branch: "auth-notification",
            availabilityOnly: event.availabilityOnly,
            profileSetChanged: event.profileSetChanged,
          });
        }),
      );
      const clear = authModule.clearRuntimeAuthProfileStoreSnapshots;
      const clearSpy = vi.spyOn(authModule, "clearRuntimeAuthProfileStoreSnapshots");
      restores.push(() => clearSpy.mockRestore());
      clearSpy.mockImplementation(() => {
        clearSpy.mockClear();
        const before = notifications;
        note({ branch: "auth-clear-enter" });
        clear();
        note({ branch: "auth-clear-return", notified: notifications !== before });
      });
      const createList = retainedModule.createChatMetadataModelList;
      const listFactorySpy = vi.spyOn(retainedModule, "createChatMetadataModelList");
      restores.push(() => listFactorySpy.mockRestore());
      listFactorySpy.mockImplementation((params) => {
        listFactorySpy.mockClear();
        const list = createList(params);
        const read = list.read.bind(list);
        const listReadSpy = vi.spyOn(list, "read");
        restores.push(() => listReadSpy.mockRestore());
        listReadSpy.mockImplementation((request) => {
          listReadSpy.mockClear();
          const pending = read(request);
          void pending.then(
            (projection) =>
              record(() => {
                if (!projection || wrappedProjections.has(projection)) {
                  return;
                }
                wrappedProjections.add(projection);
                const agent = params.facts.agents.find(
                  (entry) => entry.agentId === request.agentId,
                );
                const binding: Fact = {
                  graphFacts: identity(params.facts),
                  agentCaptured: Boolean(agent),
                };
                if (agent) {
                  Object.assign(binding, {
                    owner: identity(agent.owner.isCurrent),
                    catalog: identity(agent.modelCatalog),
                    auth: identity(agent.authStore),
                    account: account(agent.authStore),
                    catalogOldRow: oldRow(agent.modelCatalog.entries),
                    pending: Boolean(agent.modelCatalog.pendingProviders?.length),
                  });
                }
                const consume = projection.read;
                const projectionSpy = vi.spyOn(projection, "read");
                restores.push(() => projectionSpy.mockRestore());
                projectionSpy.mockImplementation(() => {
                  projectionSpy.mockClear();
                  const result = consume.call(projection);
                  record(() => {
                    bindings.set(result, binding);
                    note({
                      branch: "projection-result",
                      ...binding,
                      result: identity(result),
                      oldRow: oldRow(result.models),
                    });
                  });
                  return result;
                });
              }),
            () => record(() => note({ branch: "projection-prepare-rejected" })),
          );
          return pending;
        });
        return list;
      });
      const withPrepared = sharedModule.withPreparedGatewayRead;
      const sharedSpy = vi.spyOn(sharedModule, "withPreparedGatewayRead");
      restores.push(() => sharedSpy.mockRestore());
      sharedSpy.mockImplementation((handler, options, consume) => {
        sharedSpy.mockClear();
        if (options.req.method !== "models.list") {
          return withPrepared(handler, options, consume);
        }
        return withPrepared(handler, options, (read) => {
          const consumer = ++consumers;
          let runInvoked = false;
          let callbacks = 0;
          const run = read.run;
          const runSpy = vi.spyOn(read, "run");
          restores.push(() => runSpy.mockRestore());
          note({ branch: "shared-consume-enter", consumer });
          runSpy.mockImplementation((respond) => {
            runSpy.mockClear();
            runInvoked = true;
            note({ branch: "shared-run", consumer });
            return run.call(read, (...response) => {
              record(() => {
                callbacks += 1;
                const payload = response[1];
                note({
                  branch: "shared-producer-response",
                  consumer,
                  success: response[0],
                  result: typeof payload === "object" && payload !== null ? identity(payload) : 0,
                });
              });
              return respond(...response);
            });
          });
          const pending = consume(read);
          const settled = (returned: boolean) =>
            record(() => {
              note({ branch: "shared-consume-settled", consumer, returned, runInvoked, callbacks });
              runSpy.mockRestore();
            });
          void pending.then(
            () => settled(true),
            () => settled(false),
          );
          return pending;
        });
      });
      const retain = retainedModule.retainPublishedModelsList;
      const retainedSpy = vi.spyOn(retainedModule, "retainPublishedModelsList");
      restores.push(() => retainedSpy.mockRestore());
      retainedSpy.mockImplementation((published, previous, current) => {
        retainedSpy.mockClear();
        const result = retain(published, previous, current);
        record(() => {
          retained.add(result);
          const binding = bindings.get(published);
          if (binding) {
            bindings.set(result, binding);
          }
          note({
            branch: "retained-result",
            ...binding,
            published: identity(published),
            result: identity(result),
            previousAccount: account(previous.authStore),
            currentAccount: account(current.authStore),
            sameAuth: previous.authStore === current.authStore,
            sameConfig: previous.config === current.config,
            oldPublishedRow: oldRow(published.models),
            oldRow: oldRow(result.models),
          });
        });
        return result;
      });
      const build = resultModule.buildModelsListResult;
      const fallbackSpy = vi.spyOn(resultModule, "buildModelsListResult");
      restores.push(() => fallbackSpy.mockRestore());
      fallbackSpy.mockImplementation((...args) => {
        fallbackSpy.mockClear();
        return observe("fallback", build(...args));
      });
      const create = runtimeModule.createGatewayChatMetadataRuntime;
      const factorySpy = vi.spyOn(runtimeModule, "createGatewayChatMetadataRuntime");
      restores.push(() => factorySpy.mockRestore());
      factorySpy.mockImplementation((...args) => {
        factorySpy.mockClear();
        const runtime = create(...args);
        factories += 1;
        const read = runtime.readModelsList;
        const readSpy = vi.spyOn(runtime, "readModelsList");
        restores.push(() => readSpy.mockRestore());
        readSpy.mockImplementation((...readArgs) => {
          readSpy.mockClear();
          return observe("prepared", read(...readArgs));
        });
        return runtime;
      });
    },
    stop() {
      record(() => {
        active = false;
        for (const restore of restores.toReversed()) {
          record(restore);
        }
      });
    },
    emitFailure() {
      record(() =>
        console.error(
          "MODEL_LIST_FAILURE_DIAGNOSTIC " +
            JSON.stringify({ factories, consumers, observerFailed, truncated, events }),
        ),
      );
    },
  };
}
