import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

export const readPublicationText = (...parts: string[]) =>
  fs.readFileSync(path.join(...parts), "utf8");
export const readPublicationManifest = (directory: string) =>
  JSON.parse(readPublicationText(directory, "package.json"));

export function createPublicationTestFixture() {
  const fixture = createPackageActivationLifetimeFixture();
  let root: string;
  beforeEach(() => {
    ({ root } = fixture.setup());
    const state = path.join(root, "state");
    fs.mkdirSync(state, { mode: 0o700 });
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(state, "openclaw.json"));
  });
  afterEach(async () => {
    try {
      await fixture.lifetime.cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
  return {
    ...fixture,
    get root() {
      return root;
    },
    withFixture:
      (
        body: (
          f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
          ...args: string[]
        ) => Promise<void>,
      ) =>
      (...args: string[]) =>
        fixture.lifetime.run(async () => {
          const f = await createPackageSwapFixture(root);
          await fixture.writePostCoreCapability(f.params.stage.packageRoot);
          await body(f, ...args);
        }),
  };
}
