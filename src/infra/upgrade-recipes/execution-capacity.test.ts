import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  assertUpgradeRecipeCapacityInputs,
  measureUpgradeRecipeExecutionCapacity,
  type UpgradeRecipeExecutionCapacity,
} from "./execution-capacity.js";

let root: string;
let certificate: UpgradeRecipeExecutionCapacity;
let inputs: Parameters<typeof assertUpgradeRecipeCapacityInputs>[1];
beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recipe-capacity-")));
  for (const name of ["installation", "candidate", "runner", "artifacts", "state", "snapshots"]) {
    await fs.mkdir(path.join(root, name), { mode: 0o700 });
    await fs.writeFile(path.join(root, name, "fixture"), name);
  }
  const archivePath = path.join(root, "archive.tgz");
  await fs.writeFile(archivePath, "authenticated-fixture");
  inputs = {
    installationRoot: path.join(root, "installation"),
    candidateRoot: path.join(root, "candidate"),
    runnerRoot: path.join(root, "runner"),
    archivePath,
    stateRoot: path.join(root, "state"),
  };
  certificate = await measureUpgradeRecipeExecutionCapacity({
    ...inputs,
    candidateRoot: inputs.candidateRoot!,
    artifactsDirectory: path.join(root, "artifacts"),
    snapshotCapacity: {
      reason: "state-volume",
      sqliteBytes: 64,
      pluginBytes: 0,
      requiredBytes: 128,
      candidates: [],
      selection: {
        kind: "state-volume",
        directory: path.join(root, "snapshots", "settled-private-copy"),
      },
    },
  });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it("aggregates package, retained artifacts and snapshot scratch on the same physical filesystem", async () => {
  expect(certificate.filesystems).toHaveLength(1);
  expect(certificate.filesystems[0]!.requiredBytes).toBe(
    certificate.demands.reduce((sum, entry) => sum + entry.requiredBytes, 0),
  );
  await expect(assertUpgradeRecipeCapacityInputs(certificate, inputs)).resolves.toBeUndefined();
});

it("refuses independently claimed space that omits aggregate or native allocation demand", async () => {
  const omitted = structuredClone(certificate);
  omitted.filesystems[0]!.requiredBytes = Math.max(
    ...omitted.demands.map((entry) => entry.requiredBytes),
  );
  await expect(assertUpgradeRecipeCapacityInputs(omitted, inputs)).rejects.toThrow("aggregate");
  const understated = structuredClone(certificate);
  understated.demands[0]!.requiredBytes = 0;
  await expect(assertUpgradeRecipeCapacityInputs(understated, inputs)).rejects.toThrow(
    "allocation demand",
  );
});

it("refuses a filesystem substitution before admitting publication", async () => {
  const changed = structuredClone(certificate);
  changed.demands[0]!.device = "foreign-device";
  await expect(assertUpgradeRecipeCapacityInputs(changed, inputs)).rejects.toThrow(
    "filesystem identity changed",
  );
});

it("refuses staged inputs grown beyond the exact approved capacity bounds", async () => {
  const grown = path.join(inputs.candidateRoot!, "unexpected-expanded-tree");
  await fs.writeFile(grown, Buffer.alloc(certificate.measurements.candidateBytes + 1));
  await expect(assertUpgradeRecipeCapacityInputs(certificate, inputs)).rejects.toThrow(
    "input grew",
  );
});
