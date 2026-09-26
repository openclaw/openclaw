import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

const loadPluginIndexWriter = createLazyRuntimeModule(
  () => import("./installed-plugin-index-store-write.js"),
);
let pluginIndexWriter: Awaited<ReturnType<typeof loadPluginIndexWriter>> | undefined;

export function preparePluginSourceAdmissionCommand(type: PropertyKey): Promise<void> | undefined {
  if (type === "plugins.metadata.sourceAdmission.publish" && !pluginIndexWriter) {
    return loadPluginIndexWriter().then((loaded) => {
      pluginIndexWriter = loaded;
    });
  }
  return undefined;
}

export function executePluginSourceAdmissionCommand(
  publication: PluginSourceAdmissionPublication,
  writeOptions: OpenClawStateDatabaseOptions,
): boolean {
  if (!pluginIndexWriter) {
    throw new Error("Plugin source admission writer is not prepared");
  }
  const { publishPluginSourceAdmissionInDatabase } = pluginIndexWriter;
  return runOpenClawStateWriteTransaction(
    ({ db }) => publishPluginSourceAdmissionInDatabase(db, publication),
    writeOptions,
  );
}
