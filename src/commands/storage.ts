import { randomBytes, randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../config/config.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  initStorageLocation,
  listStorageLocations,
  openStorageLocation,
  probeStorageLocation,
  storageLocationError,
  type StorageProbeResult,
} from "../storage/locations.js";
import { acquireStorageProvider } from "../storage/provider.js";

type StorageCommandOptions = { json?: boolean };

export async function storageListCommand(runtime: RuntimeEnv, opts: StorageCommandOptions) {
  const config = getRuntimeConfig();
  const locations = [];
  for (const location of listStorageLocations(config)) {
    let displayTarget = location.displayTarget;
    let probe: StorageProbeResult;
    try {
      const acquired = await acquireStorageProvider({ providerId: location.provider, config });
      try {
        const settings = config.storage?.locations?.[location.name]?.settings;
        if (settings) {
          displayTarget = acquired.provider.describeTarget?.(settings);
        }
        probe = await probeStorageLocation({
          name: location.name,
          config,
          registry: acquired.registry,
        });
      } finally {
        await acquired.release();
      }
    } catch (error) {
      const { state, message } = storageLocationError(error);
      probe = { state, message };
    }
    locations.push({
      ...location,
      ...(displayTarget === undefined ? {} : { displayTarget }),
      ...probe,
    });
  }
  if (opts.json) {
    writeRuntimeJson(runtime, { locations });
    return;
  }
  if (locations.length === 0) {
    runtime.log("No storage locations configured. Configure storage.locations to add one.");
  }
  for (const location of locations) {
    runtime.log(
      `${location.name} (${location.provider}): ${location.state}${location.displayTarget ? ` — ${location.displayTarget}` : ""}${location.message ? `\n  ${location.message}` : ""}`,
    );
  }
}

export async function storageInitCommand(
  runtime: RuntimeEnv,
  name: string,
  opts: StorageCommandOptions,
) {
  const location = await initStorageLocation({ name, config: getRuntimeConfig() });
  try {
    const description = location.describe();
    if (opts.json) {
      writeRuntimeJson(runtime, { ...description, state: "ok" });
    } else {
      runtime.log(`Storage location ${name} initialized: ${description.displayTarget}`);
    }
  } finally {
    await location.close();
  }
}

export async function storageTestCommand(
  runtime: RuntimeEnv,
  name: string,
  opts: StorageCommandOptions,
) {
  const location = await openStorageLocation({ name, config: getRuntimeConfig() });
  try {
    const key = `.openclaw-probe-${randomUUID()}`;
    const payload = randomBytes(256);
    await location.putObject(
      key,
      (async function* () {
        yield payload;
      })(),
      { sizeBytes: payload.length },
    );
    try {
      const body = await location.getObject(key);
      if (!body) {
        throw new Error(`Storage test for "${name}" failed: the written object is missing.`);
      }
      let offset = 0;
      for await (const chunk of body) {
        if (
          offset + chunk.length > payload.length ||
          !payload.subarray(offset, offset + chunk.length).equals(chunk)
        ) {
          throw new Error(`Storage test for "${name}" failed: read-back bytes differ.`);
        }
        offset += chunk.length;
      }
      if (offset !== payload.length) {
        throw new Error(`Storage test for "${name}" failed: read-back bytes are truncated.`);
      }
    } finally {
      await location.delete(key);
    }
    if (opts.json) {
      writeRuntimeJson(runtime, { ...location.describe(), state: "ok", sizeBytes: payload.length });
    } else {
      runtime.log(
        `Storage location ${name}: wrote, read, verified, and deleted ${payload.length} bytes.`,
      );
    }
  } finally {
    await location.close();
  }
}
