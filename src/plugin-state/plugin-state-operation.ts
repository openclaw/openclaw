import { randomUUID } from "node:crypto";
import type { SessionEntriesCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  beginPluginStateMutation,
  capturePluginStateEpochs,
  capturePluginStateMutationSettlement,
} from "./plugin-state-operation-epochs.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";
import { capturePluginStateNativeBindingStore } from "./plugin-state-store.native-binding.js";
import type {
  PluginStateKeyedStore,
  PluginStateOperation,
  PluginStateOperationDefinitions,
  PluginStateOperationReceipt,
} from "./plugin-state-store.types.js";
import { invalidInput } from "./plugin-state-store.validation.js";
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

/** Capture module generation, source, and live grants before dispatch can suspend. */
export function createPluginStateOperation<Operations extends PluginStateOperationDefinitions>(
  owner: object,
  stores: readonly Pick<PluginStateKeyedStore<unknown>, "lookup" | "entries">[],
  handler: { moduleName: string; exportName: string },
  authority?: { assertCurrent(): void; sourceReceipt?: PluginStateOperationReceipt<unknown> },
): PluginStateOperation<Operations> {
  if (stores.length === 0 || stores.length > 10_000) {
    throw invalidInput("Plugin state operations require between 1 and 10000 stores.");
  }
  if (!handler.exportName || (authority && typeof authority.assertCurrent !== "function")) {
    throw invalidInput("Plugin state operation requires a named handler and valid authority.");
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
  if (!ownerBinding.moduleSource) {
    throw invalidInput("Plugin state operation has no captured plugin module source.");
  }
  const module = ownerBinding.moduleSource.resolve(handler.moduleName);
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
  return {
    async execute(command, options) {
      assertActive();
      const writes = select(options.writeStores);
      const watches = select(options.watchStores ?? bindings.map((_, index) => index));
      const receiptId = randomUUID();
      const missing = Object.hasOwn(options, "missingValue")
        ? { value: options.missingValue, validUntil: undefined }
        : undefined;
      const mutation = writes.length
        ? beginPluginStateMutation(context.admission.coordinationKey, writes)
        : undefined;
      const prior = capturePluginStateMutationSettlement(
        context.admission.coordinationKey,
        [...watches, ...writes],
        mutation?.token,
      );
      let validUntil: number | undefined;
      let committed = writes.length === 0;
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
            module,
            exportName: handler.exportName,
            stores: bindings.map(({ options: { env: _env, ...scope } }) => scope),
            writeStores: [...options.writeStores],
            command,
            receiptId,
          },
          {
            missing: missing ? () => missing : undefined,
            onCommitted(facts) {
              if (facts.receiptId !== receiptId) {
                throw new Error("Plugin state operation received another operation's receipt");
              }
              validUntil = facts.validUntil;
              committed = true;
            },
          },
        );
        if (!committed) {
          throw new Error("Plugin state operation has no committed receipt");
        }
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
        mutation?.finish();
      }
    },
  };
}
