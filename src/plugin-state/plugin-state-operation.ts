import { randomUUID } from "node:crypto";
import { toUSVString } from "node:util";
import type { SessionEntriesCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PluginStateOperationHandlerSource } from "./plugin-state-operation-contract.js";
import {
  beginPluginStateMutation,
  capturePluginStateEpochs,
  capturePluginStateMutationSettlement,
} from "./plugin-state-operation-epochs.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";
import { beginPluginStatePublication } from "./plugin-state-publication.js";
import { capturePluginStateNativeBindingStore } from "./plugin-state-store.native-binding.js";
import type {
  PluginStateKeyedStore,
  PluginStateOperation,
  PluginStateOperationDefinitions,
  PluginStateOperationReceipt,
} from "./plugin-state-store.types.js";
import { invalidInput, validateKey } from "./plugin-state-store.validation.js";
import { executePluginStateOperationInWorker } from "./plugin-state-worker-client.js";

const receiptSources = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginStateOperationReceiptSources"),
  () =>
    new WeakMap<
      object,
      {
        context: ReturnType<typeof captureOpenClawStateWorkerContext>;
        pluginId: string;
        assertCurrent(): void;
      }
    >(),
);

type Store = Pick<PluginStateKeyedStore<unknown>, "lookup" | "entries">;
type Authority = { assertCurrent(): void; sourceReceipt?: PluginStateOperationReceipt<unknown> };
type Binding = NonNullable<ReturnType<typeof capturePluginStateNativeBindingStore>>;

// Admit a full repairable namespace while bounding the work of a single native commit.
const MAX_DELETE_KEYS = 50_000;

/** Deletes exact keys from one or two host-owned stores in one transaction. */
export async function deletePluginStateKeys(
  owner: Store,
  keys: readonly string[],
  alsoFrom?: Store,
): Promise<void> {
  if (!Array.isArray(keys) || keys.length > MAX_DELETE_KEYS) {
    throw invalidInput("Plugin state deletion requires at most 50000 exact keys.", "delete");
  }
  const uniqueKeys = new Set<string>();
  const count = keys.length;
  for (let index = 0; index < count; index++) {
    const key = keys[index];
    if (typeof key !== "string") {
      throw invalidInput("Plugin state deletion requires string keys.", "delete");
    }
    uniqueKeys.add(toUSVString(validateKey(key, "delete")));
  }
  const stores = alsoFrom === undefined || alsoFrom === owner ? [owner] : [owner, alsoFrom];
  const operation = preparePluginStateOperation(owner, stores, () => ({
    deleteKeys: [...uniqueKeys],
  }));
  // Distinct granted handles can name one native namespace. Keep both grants
  // current through commit, but delete each row only once.
  const [first, peer] = stores.map(capturePluginStateNativeBindingStore);
  const writeStores = peer && peer.options.namespace !== first?.options.namespace ? [0, 1] : [0];
  await operation.execute({ type: "deleteKeys", input: undefined }, { writeStores });
}

/** Capture module generation, source, and live grants before dispatch can suspend. */
export function createPluginStateOperation<Operations extends PluginStateOperationDefinitions>(
  owner: object,
  stores: readonly Store[],
  handler: { moduleName: string; exportName: string },
  authority?: Authority,
): PluginStateOperation<Operations> {
  if (!handler.exportName || (authority && typeof authority.assertCurrent !== "function")) {
    throw invalidInput("Plugin state operation requires a named handler and valid authority.");
  }
  return preparePluginStateOperation<Operations>(
    owner,
    stores,
    (binding) => {
      if (!binding.moduleSource) {
        throw invalidInput("Plugin state operation has no captured plugin module source.");
      }
      return {
        module: binding.moduleSource.resolve(handler.moduleName),
        exportName: handler.exportName,
      };
    },
    authority,
  );
}

function preparePluginStateOperation<Operations extends PluginStateOperationDefinitions>(
  owner: object,
  stores: readonly Store[],
  resolveHandler: (binding: Binding) => PluginStateOperationHandlerSource,
  authority?: Authority,
): PluginStateOperation<Operations> {
  if (stores.length === 0 || stores.length > 10_000) {
    throw invalidInput("Plugin state operations require between 1 and 10000 stores.");
  }
  const capture = (store: object) => {
    const binding = capturePluginStateNativeBindingStore(store);
    if (!binding) {
      throw invalidInput("Plugin state operations require host-owned stores.");
    }
    binding.assertCurrent?.();
    return binding;
  };
  const ownerBinding = capture(owner);
  const handler = resolveHandler(ownerBinding);
  const bindings = stores.map(capture);
  const allBindings = [...new Set([ownerBinding, ...bindings])];
  const context = captureOpenClawStateWorkerContext({ env: ownerBinding.options.env });
  const contexts = new Map([[ownerBinding.options.env, context]]);
  for (const binding of allBindings) {
    if (binding.options.pluginId !== ownerBinding.options.pluginId) {
      throw invalidInput("Plugin state operations require stores belonging to one plugin.");
    }
    let candidate = contexts.get(binding.options.env);
    if (!candidate) {
      candidate = captureOpenClawStateWorkerContext({ env: binding.options.env });
      contexts.set(binding.options.env, candidate);
    }
    if (
      candidate.admission.databasePath !== context.admission.databasePath ||
      candidate.admission.identity.key !== context.admission.identity.key ||
      candidate.admission.identity.birthtime !== context.admission.identity.birthtime
    ) {
      throw invalidInput("Plugin state operations require one physical state source.");
    }
  }
  if (authority?.sourceReceipt) {
    const source = receiptSources.get(authority.sourceReceipt);
    if (
      !source ||
      source.pluginId !== ownerBinding.options.pluginId ||
      source.context.admission.databasePath !== context.admission.databasePath ||
      source.context.admission.identity.key !== context.admission.identity.key ||
      source.context.admission.identity.birthtime !== context.admission.identity.birthtime
    ) {
      throw invalidInput("Plugin state operation receipt belongs to another source or plugin.");
    }
    source.assertCurrent();
  }
  const checks = [...new Set(allBindings.flatMap((binding) => binding.sessionEntryCurrent ?? []))];
  const sessionEntryCurrent: SessionEntriesCurrentCheck | undefined = checks.length
    ? {
        sources: checks.flatMap((check) => ("source" in check ? [check.source] : check.sources)),
        assertCurrent(entries) {
          let offset = 0;
          for (const check of checks) {
            if ("source" in check) {
              check.assertCurrent(entries[offset++]);
            } else {
              check.assertCurrent(entries.slice(offset, offset + check.sources.length));
              offset += check.sources.length;
            }
          }
        },
      }
    : undefined;
  const assertActive = () => {
    for (const captured of contexts.values()) {
      captured.admission.assertCurrent();
    }
    for (const binding of allBindings) {
      binding.assertCurrent?.();
    }
    authority?.assertCurrent();
  };
  const select = (indices: readonly number[]) =>
    [...new Set(indices)].map((index) => {
      const binding = Number.isSafeInteger(index) ? bindings[index] : undefined;
      if (!binding) {
        throw invalidInput("Plugin state operation names an unknown store.");
      }
      return binding.options;
    });
  assertActive();
  let preparedEmptyShortcut = false;
  return {
    async execute(command, options) {
      assertActive();
      const writes = select(options.writeStores);
      const emptyStores = options.ifEmpty ? select([options.ifEmpty.store]) : [];
      if (options.ifEmpty && writes.length) {
        throw invalidInput("Plugin state empty shortcuts require a read-only operation.");
      }
      const watches = select(options.watchStores ?? bindings.map((_, index) => index));
      const receiptId = randomUUID();
      const missing = Object.hasOwn(options, "missingValue")
        ? { value: options.missingValue, validUntil: undefined }
        : undefined;
      // Exact-key deletion joins the commit but returns no guard to its caller.
      const mutation = writes.length
        ? beginPluginStateMutation(
            context.admission.coordinationKey,
            writes,
            "deleteKeys" in handler ? "command" : "receipt",
          )
        : undefined;
      const prior = capturePluginStateMutationSettlement(
        context.admission.coordinationKey,
        [...watches, ...writes, ...emptyStores],
        mutation?.token,
      );
      let validUntil: number | undefined;
      let committed = writes.length === 0;
      const publication = writes.length
        ? beginPluginStatePublication(() => context.admission.identity.key)
        : undefined;
      try {
        if (prior) {
          await prior;
          assertActive();
        }
        const assertEpochs = capturePluginStateEpochs(
          context.admission.coordinationKey,
          watches,
          mutation?.token,
        );
        const assertCurrent = () => {
          assertActive();
          assertEpochs();
          if (!committed || (validUntil !== undefined && Date.now() >= validUntil)) {
            throw new PluginStateOperationInvalidatedError();
          }
        };
        const result = await executePluginStateOperationInWorker(
          {
            context,
            assertActive,
            sessionEntryCurrent,
            ...handler,
            stores: bindings.map(({ options: { env: _env, ...scope } }) => scope),
            writeStores: [...options.writeStores],
            ifEmpty: options.ifEmpty,
            command,
            receiptId,
          },
          {
            missing: missing ? () => missing : undefined,
            preparedEmptyShortcut,
            onCommitted(facts) {
              if (facts.receiptId !== receiptId) {
                throw new Error("Plugin state operation received another operation's receipt");
              }
              committed = true;
            },
          },
        );
        if (!committed) {
          throw new Error("Plugin state operation has no committed receipt");
        }
        preparedEmptyShortcut ||= result.emptyShortcut === true;
        validUntil = result.validUntil;
        if (writes.length === 0) {
          assertActive();
        }
        const receipt = {
          // SAFETY: The registered handler owns this discriminated operation's output contract.
          value: result.value as Operations[typeof command.type]["output"],
          assertCurrent,
        };
        receiptSources.set(receipt, {
          context,
          pluginId: ownerBinding.options.pluginId,
          assertCurrent,
        });
        return receipt;
      } finally {
        try {
          publication?.finish("completed");
        } finally {
          mutation?.finish();
        }
      }
    },
  };
}
