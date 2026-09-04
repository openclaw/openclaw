import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { convertPathToPattern } from "tinyglobby";
import { expect } from "vitest";
import { vitestArtifactDirectory } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { createWorkerArtifactTest, writeFixture } from "./vitest-worker-artifacts.test-support.js";

const it = createWorkerArtifactTest();
const root = process.cwd();

function handoffProbe(directory: string) {
  const stage = path.join(root, "src/infra/update-managed-service-handoff-runtime.ts");
  const test = writeFixture(
    directory,
    "handoff.test.ts",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import {createRequire} from 'node:module';
    import {expect,it} from 'vitest';
    import {stageManagedHandoffRuntime} from ${JSON.stringify(stage)};
    it('stages and executes the actual lease owner from current source', () => {
      const directory = ${JSON.stringify(directory)};
      const [entry] = stageManagedHandoffRuntime(directory);
      if(process.platform !== 'win32') expect(fs.statSync(entry).mode & 0o777).toBe(0o600);
      const {createManagedHandoffLeaseRuntime} = createRequire(import.meta.url)(entry);
      const owner = createManagedHandoffLeaseRuntime({
        databasePath:path.join(directory,'state','lease.sqlite'), serviceManagerEnv:{}
      });
      const claim = owner.acquire(directory,'source-borrower',{kind:'update'});
      expect(claim.kind).toBe('acquired');
      expect(owner.owns(claim.lease)).toBe(true);
      expect(owner.release(claim.lease)).toBe(true);
      expect(owner.read(directory)).toEqual({kind:'absent'});
      fs.writeFileSync(path.join(directory,'staged'),entry);
    });
  `,
  );
  return writeFixture(
    directory,
    "vitest.config.mts",
    `
    import {sharedVitestConfig as shared} from ${JSON.stringify(pathToFileURL(path.join(root, "test/vitest/vitest.shared.config.ts")).href)};
    export default {...shared,root:${JSON.stringify(root)},test:{...shared.test,include:[${JSON.stringify(convertPathToPattern(test))}],maxWorkers:1}};
  `,
  );
}

it("prepares only the sealed member for source staging and reuses it for worker demand", ({
  workerArtifacts,
}) =>
  workerArtifacts.fixtureLifetime.run(async () => {
    const { startBorrower, prepareWorkers } = workerArtifacts.createFixtureCommands();
    const owner = createVitestWorkerRun();
    const directory = workerArtifacts.fixtureDirectory();
    const member = vitestArtifactDirectory(owner.descriptor.directory, "handoff");
    try {
      const config = handoffProbe(directory);
      const result = await startBorrower(owner, ["run", "--config", config]).result;
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(fs.existsSync(path.join(directory, "staged"))).toBe(true);
      expect(fs.existsSync(path.join(owner.descriptor.directory, "manifest.json"))).toBe(false);
      const before = fs.readFileSync(path.join(member, "manifest.json"), "utf8");
      const manifest = JSON.parse(before);
      expect(Object.keys(manifest.outputs)).toHaveLength(2);
      expect(Object.keys(manifest.inputs)).toContain(
        path.join(root, "src/infra/update-managed-service-handoff-lease-runtime.ts"),
      );
      await prepareWorkers(owner);
      expect(fs.readFileSync(path.join(member, "manifest.json"), "utf8")).toBe(before);
    } finally {
      await owner.dispose();
    }
  }));

it.for(["missing", "tampered"])(
  "refuses %s sealed output before a source borrower stages it",
  (damage, { workerArtifacts }) =>
    workerArtifacts.fixtureLifetime.run(async () => {
      const { startBorrower, prepareWorkers } = workerArtifacts.createFixtureCommands();
      const owner = createVitestWorkerRun();
      const directory = workerArtifacts.fixtureDirectory();
      const member = vitestArtifactDirectory(owner.descriptor.directory, "handoff");
      const entry = path.join(member, "dist/managed-handoff-runtime.mjs");
      let original: Buffer | undefined;
      try {
        await prepareWorkers(owner, "handoff");
        original = fs.readFileSync(entry);
        if (damage === "missing") {
          fs.unlinkSync(entry);
        } else {
          fs.appendFileSync(entry, "\nthrow new Error('tampered runtime');\n");
        }
        const result = await startBorrower(owner, ["run", "--config", handoffProbe(directory)])
          .result;
        expect(result.code).not.toBe(0);
        expect(result.stderr + result.stdout).toContain(
          damage === "missing" ? "ENOENT" : "Compiled subprocess artifact changed",
        );
        expect(fs.existsSync(path.join(directory, "staged"))).toBe(false);
        expect(fs.existsSync(path.join(directory, "runtime"))).toBe(false);
      } finally {
        if (original) {
          fs.writeFileSync(entry, original);
        }
        await owner.dispose();
      }
    }),
);
