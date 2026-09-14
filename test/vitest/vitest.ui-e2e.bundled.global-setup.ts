// The first selected bundle consumer owns the invocation-wide build/preview and teardown.
import path from "node:path";
import type { TestProject } from "vitest/node";
import {
  startBuiltControlUiE2eServer,
  startBundledControlUiE2eServer,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createTempDirTracker } from "../helpers/temp-dir.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eServerBaseUrl: string | null;
  }
}

export default async function setup(project: TestProject) {
  const root = project.vitest.getRootProject();
  // Vitest initializes selected project setups sequentially and tears them down only
  // when the invocation closes. Later consumers borrow the root fact, not its cleanup.
  if (root.getProvidedContext().controlUiE2eServerBaseUrl !== undefined) {
    return undefined;
  }
  const { available } = project.getProvidedContext().controlUiE2eChromium;
  if (!available) {
    root.provide("controlUiE2eServerBaseUrl", null);
    return undefined;
  }

  // Local full-suite runs can fan shards into separate processes in one checkout.
  // Keep every build out of canonical dist so those processes cannot clobber it.
  const tempDirs = createTempDirTracker();
  const generation = root.getProvidedContext().controlUiE2ePrebuiltGeneration;
  if (generation !== undefined && !/^[a-f0-9]{64}$/u.test(generation)) {
    throw new Error("Prebuilt Control UI preview requires an admitted generation");
  }
  // The prebuilt setup owns freshness before acquisition and after all readers
  // close. Borrow its exact UI output; never rebuild or delete that generation.
  const outDir = generation
    ? path.join(root.config.root, "dist", "control-ui")
    : tempDirs.make("openclaw-ui-e2e-");
  const startServer = generation ? startBuiltControlUiE2eServer : startBundledControlUiE2eServer;
  const server = await startServer(outDir).catch(async (error: unknown) => {
    try {
      tempDirs.cleanup();
    } catch {}
    throw error;
  });
  try {
    root.provide("controlUiE2eServerBaseUrl", server.baseUrl);
    return async () => {
      try {
        await server.close();
      } finally {
        tempDirs.cleanup();
      }
    };
  } catch (error) {
    await server.close().catch(() => {});
    try {
      tempDirs.cleanup();
    } catch {}
    throw error;
  }
}
