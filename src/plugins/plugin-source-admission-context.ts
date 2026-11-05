import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

type AdmissionPublisher = (publication: PluginSourceAdmissionPublication) => Promise<boolean>;
const publisherContext = new AsyncLocalStorage<AdmissionPublisher | undefined>();

/** Capture workers receive publication authority from their host, never from its database. */
export function withPluginSourceAdmissionPublisher<T>(
  publisher: AdmissionPublisher | undefined,
  run: () => T,
): T {
  return publisherContext.run(publisher, run);
}

export function getPluginSourceAdmissionPublisher(): AdmissionPublisher | undefined {
  return publisherContext.getStore();
}
