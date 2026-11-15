import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import type {
  PackageUpdateTransaction,
  StagedPackageSwapParams,
} from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import type { UpdateRecoveryFence } from "./update-run-recovery-types.js";

export function withPublicationFence<T>(
  root: string,
  body: (fence: UpdateRecoveryFence) => Promise<T>,
) {
  return withUpdateCommandExecutor(randomUUID(), async (executor) =>
    body(await executor.enter(root)),
  );
}

export const publicationActivation = (fence: UpdateRecoveryFence) => ({
  fence,
  runtime: packageActivationRuntimeForTest(),
  onPrepared: () => {},
});

export async function runPublicationSwap(
  f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
  fence: UpdateRecoveryFence,
  options: Partial<StagedPackageSwapParams> = {},
) {
  let transaction: PackageUpdateTransaction | undefined;
  const result = await swapStagedPackageInstall({
    ...f.params,
    activation: publicationActivation(fence),
    ...options,
    onTransaction: (issued) => {
      transaction = issued;
      return options.onTransaction?.(issued);
    },
  });
  return { result, transaction };
}

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
  afterEach(async () => fixture.cleanup());
  return {
    ...fixture,
    get root() {
      return root;
    },
    withFixture:
      <T extends unknown[]>(
        body: (
          f: Awaited<ReturnType<typeof createPackageSwapFixture>>,
          ...args: T
        ) => Promise<void>,
        capable = true,
      ) =>
      (...args: T) =>
        fixture.lifetime.run(async () => {
          const f = await createPackageSwapFixture(root);
          if (capable) {
            await fixture.writePostCoreCapability(f.params.stage.packageRoot);
          }
          await body(f, ...args);
        }),
  };
}
