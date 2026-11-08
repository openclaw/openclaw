import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import * as tempRoot from "./tmp-openclaw-dir.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";

export const triageLeaseFixtureLifetime = createFixtureLifetime();

export function useTriageLeaseDatabaseFixture() {
  let restoreTempRoot = () => {};
  afterAll(async () => {
    try {
      await triageLeaseFixtureLifetime.cleanup();
    } finally {
      restoreTempRoot();
    }
  });
  beforeAll(() =>
    triageLeaseFixtureLifetime.run(async () => {
      const directory = triageLeaseFixtureLifetime.createTempDir("triage-lease-coordinator-");
      const selector = vi
        .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
        .mockReturnValue(directory);
      restoreTempRoot = () => selector.mockRestore();
      const bootstrap = path.join(directory, "bootstrap.mjs");
      const registry = resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.sealedRuntime).href;
      await fs.writeFile(
        bootstrap,
        `import { registerSealedRuntime } from ${JSON.stringify(registry)};
registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ${JSON.stringify(directory)} });
`,
      );
    }),
  );
}
