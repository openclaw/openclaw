import {
  admitUpdateInitialStores,
  type UpdateInitialStoreSelection,
} from "./update-initial-store-admission.js";

/** Correlation only. The native lease and the state publication owner retain authority. */
export type UpdateInitialStoreTransport = Readonly<{
  protocol: "initial-pair-v1";
  selection: UpdateInitialStoreSelection;
}>;

export function admitUpdateInitialStoreTransport(
  input: UpdateInitialStoreTransport,
  selectors: { installationRoot: string; handoffPath: string; statePath: string },
) {
  if (!input || input.protocol !== "initial-pair-v1" || !input.selection) {
    throw new Error("Update initial store transport is missing or unsupported.");
  }
  const admission = admitUpdateInitialStores(input.selection);
  admission.assertCurrent(selectors);
  return admission;
}

/** Snapshot selected facts; this never captures/restats a successor generation. */
export function snapshotUpdateInitialStoreTransport(input: UpdateInitialStoreTransport) {
  const selection = input?.selection;
  const admission = admitUpdateInitialStoreTransport(input, {
    installationRoot: selection?.installation.path,
    handoffPath: selection?.handoff.databasePath,
    statePath: selection?.state.databasePath,
  });
  const transport: UpdateInitialStoreTransport = Object.freeze({
    protocol: "initial-pair-v1",
    selection: admission.selection,
  });
  admission.close();
  return transport;
}
