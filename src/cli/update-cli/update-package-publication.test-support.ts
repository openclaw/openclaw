import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.js";
import { encodePackageActivationLauncher } from "../../infra/package-update-activation-journal.js";
import { preparePackageActivationJournal } from "../../infra/package-update-activation-prepare.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "../../infra/package-update-activation.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import { createPublicationOwner } from "../../infra/package-update-publication-owner.js";
import {
  publicationActivation,
  withPublicationFence,
} from "../../infra/package-update-publication.test-support.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";

export async function createInterruptedPackagePublication(
  fixtureRoot: string,
  phase: "prepared" | "publishing" | "publication-complete" = "publishing",
) {
  const f = await createPackageSwapFixture(fixtureRoot);
  const stageRoot = f.params.stage.packageRoot;
  const write = (file: string, value: string | object) => {
    const target = path.join(stageRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", {
    name: "openclaw",
    version: "2.0.0",
    type: "module",
    main: "dist/index.js",
    exports: { ".": { import: "./dist/index.js", default: ["./dist/index.js", null] } },
    bin: { openclaw: "openclaw.mjs" },
  });
  write("openclaw.mjs", 'import "./dist/index.js";\n');
  write("dist/scoped/package.json", { type: "module" });
  write("dist/build-info.json", { version: "2.0.0" });
  const stagedLauncher = path.join(f.params.stage.layout.binDir, "openclaw");
  fs.unlinkSync(stagedLauncher);
  fs.symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", stagedLauncher);
  for (const dependency of ["dep-a", "@scope/dep-b", "dep-a/node_modules/dep-c"]) {
    write(`node_modules/${dependency}/package.json`, { type: "commonjs" });
  }
  await writePackageDistInventory(stageRoot);
  const reader = createPackageIntegrityReader();
  const prepared = await withPublicationFence(f.packageRoot, async (fence) => {
    const preparation = await preparePackageActivationJournal({
      options: publicationActivation(fence),
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
    const { anchor, journal, initial } = preparation;
    if (phase === "prepared") {
      // An external install selected the candidate without advancing the journal.
      fs.renameSync(f.packageRoot, path.join(anchor, "previous"));
      fs.renameSync(path.join(anchor, "candidate"), f.packageRoot);
      fs.unlinkSync(f.launcher);
      fs.symlinkSync(fs.readlinkSync(path.join(anchor, "launchers/openclaw")), f.launcher);
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
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent, initial);
      const publication = owner.publish(false);
      await (phase === "publishing"
        ? expect(publication).rejects.toThrow("external write during publication")
        : publication);
    } finally {
      interruption.mockRestore();
    }
    return preparation;
  });
  const { anchor, journal } = prepared;
  const record = journal.read();
  const operationId = record.descriptor.operationId;
  expect(record.phase).toBe(phase);
  if (phase === "publishing") {
    await expect(runPackageActivationRecovery(anchor, "repair", operationId)).rejects.toThrow(
      "Package publication object changed",
    );
    await expect(runPackageActivationRecovery(anchor, "retire", operationId)).rejects.toThrow(
      "Package evidence cannot be retired (publishing)",
    );
  }
  expect(await readPackageActivationStatus(anchor, operationId)).toMatchObject({ phase });
  return { ...f, ...prepared, record };
}
