import path from "node:path";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

export function createDoctorGenerationFixture(rootDir: string, id: string) {
  const source = path.join(rootDir, "doctor-contract-api.mjs");
  return {
    source,
    input: {
      config: {},
      env: {},
      stateDir: rootDir,
      oauthDir: rootDir,
      context: {
        openPluginStateKeyedStore() {
          throw new Error("fixture must not open state");
        },
      },
    },
    inventory: (doctorContract: PluginManifestRecord["doctorContract"]) => {
      return {
        records: [
          createPluginManifestRecordFixture({
            id,
            rootDir,
            source,
            origin: "global",
            doctorContract,
          }),
        ],
        knownPluginIds: [id],
        sessionStoreOwnerPluginIds: [],
        descriptors: [],
        unresolvedPluginIds: [],
      };
    },
  };
}
