import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX } from "../infra/update-managed-service-handoff-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { lastWriteJsonCall } from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import { readPackageVersion } from "./update-cli-mocks.test-support.js";
import { updateCommand } from "./update-cli-modules.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const setup = createUpdateCliFixture();

it("preserves another handoff's aged preparation directory during an update", async () => {
  const root = await setup.mockPackageInstallAtCaseDir();
  readPackageVersion.mockImplementation(async (packageRoot: string) => {
    const manifest: { version: string } = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    return manifest.version;
  });
  const tmpDir = setup.tempDirs.make("openclaw-update-handoff-cleanup-");
  const preparing = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}preparing`);
  // Helpers create this directory before awaiting metadata and writing handoff.json.
  await fs.mkdir(preparing);
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  await fs.utimes(preparing, old, old);

  await withEnvAsync({ TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir }, () =>
    updateCommand({ yes: true, restart: false, json: true }),
  );

  expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
  expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
    version: "9999.0.0",
  });
  await expect(fs.readdir(preparing)).resolves.toEqual([]);
});
