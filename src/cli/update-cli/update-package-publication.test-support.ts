import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { encodePackageActivationLauncher } from "../../infra/package-update-activation-journal.js";
import { preparePackageActivationJournal } from "../../infra/package-update-activation-prepare.js";
import { packageActivationRuntimeForTest } from "../../infra/package-update-activation-runtime.test-support.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "../../infra/package-update-activation.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

export async function createInterruptedPackagePublication(
  fixtureRoot: string,
  phase: "prepared" | "publishing" | "publication-complete" = "publishing",
) {
  const f = await createPackageSwapFixture(fixtureRoot);
  const stageRoot = f.params.stage.packageRoot;
  fs.writeFileSync(
    path.join(stageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2.0.0",
      type: "module",
      main: "dist/index.js",
      exports: {
        ".": { import: "./dist/index.js", default: ["./dist/index.js", null] },
        "./nested": "./dist/nested/index.js",
        "./cli-entry": "./openclaw.mjs",
        "./package.json": "./package.json",
      },
      bin: { openclaw: "openclaw.mjs" },
    }),
  );
  fs.writeFileSync(path.join(stageRoot, "openclaw.mjs"), 'import "./dist/index.js";\n');
  const stagedLauncher = path.join(f.params.stage.layout.binDir, "openclaw");
  fs.unlinkSync(stagedLauncher);
  fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", stagedLauncher);
  fs.writeFileSync(path.join(stageRoot, "README.md"), "Synthetic package README\n");
  fs.writeFileSync(path.join(stageRoot, "LICENSE"), "Synthetic package license\n");
  for (const dependency of ["dep-a", "@scope/dep-b", "dep-a/node_modules/dep-c"]) {
    const directory = path.join(stageRoot, "node_modules", dependency);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: path.basename(dependency), version: "1.0.0", type: "commonjs" }),
    );
  }
  fs.mkdirSync(path.join(stageRoot, "dist/nested"));
  fs.writeFileSync(path.join(stageRoot, "dist/nested/index.js"), "export {};\n");
  fs.mkdirSync(path.join(stageRoot, "dist/scoped"));
  fs.writeFileSync(
    path.join(stageRoot, "dist/scoped/package.json"),
    JSON.stringify({ type: "module" }),
  );
  fs.writeFileSync(
    path.join(stageRoot, "dist/build-info.json"),
    JSON.stringify({ version: "2.0.0" }),
  );
  await writePackageDistInventory(stageRoot);
  const reader = createPackageIntegrityReader();
  const prepared = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(f.packageRoot);
    const preparation = await preparePackageActivationJournal({
      options: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
      liveRoot: f.packageRoot,
      stageRoot,
      launcherRoot: f.params.stage.layout.binDir,
      binDir: path.dirname(f.launcher),
      previous: await reader.tree(f.packageRoot),
      launchers: [
        {
          name: "openclaw",
          previous: encodePackageActivationLauncher(await reader.launcher(f.launcher)),
        },
      ],
    });
    if (phase === "prepared") {
      // An external install selected the candidate without advancing the journal.
      fs.renameSync(f.packageRoot, path.join(preparation.anchor, "previous"));
      fs.renameSync(path.join(preparation.anchor, "candidate"), f.packageRoot);
      fs.unlinkSync(f.launcher);
      fs.symlinkSync(
        fs.readlinkSync(path.join(preparation.anchor, "launchers/openclaw")),
        f.launcher,
      );
      return preparation;
    }
    const rename = fsp.rename.bind(fsp);
    const interruption = vi.spyOn(fsp, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === f.launcher && phase === "publishing") {
        const file = path.join(f.packageRoot, "dist/index.js");
        const original = fs.readFileSync(file);
        fs.writeFileSync(`${file}.bak`, original);
        fs.writeFileSync(file, "// external patch\n");
        fs.writeFileSync(file, original);
        throw new Error("external write during publication");
      }
    });
    try {
      const publication = createPublicationOwner(
        preparation.anchor,
        preparation.journal,
        fence.assertCurrent,
        preparation.initial,
      ).publish(false);
      if (phase === "publishing") {
        await expect(publication).rejects.toThrow("external write during publication");
      } else {
        await publication;
      }
    } finally {
      interruption.mockRestore();
    }
    return preparation;
  });
  const record = prepared.journal.read();
  expect(record.phase).toBe(phase);
  if (phase === "publishing") {
    await expect(
      runPackageActivationRecovery(prepared.anchor, "repair", record.descriptor.operationId),
    ).rejects.toThrow("Package publication object changed");
    await expect(
      runPackageActivationRecovery(prepared.anchor, "retire", record.descriptor.operationId),
    ).rejects.toThrow("Package evidence cannot be retired (publishing)");
  }
  expect(
    await readPackageActivationStatus(prepared.anchor, record.descriptor.operationId),
  ).toMatchObject({ phase });
  return { ...f, ...prepared, record };
}
