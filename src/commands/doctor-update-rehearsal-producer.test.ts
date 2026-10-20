import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUpdateCandidateRehearsal } from "../infra/update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "../infra/update-candidate-state.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { inspectPreparedDoctorRehearsal } from "./doctor-update-rehearsal-inventory.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("admits real producer plugin host, dependency and basename links without traversing the candidate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (source) => {
    const root = dirs.make("rehearsal-plugin-source-");
    const candidate = path.join(root, "candidate");
    const plugin = path.join(root, "payload");
    const locator = path.join(root, "example");
    const modules = path.join(root, "modules");
    await fs.mkdir(candidate);
    await materializeUpdateCandidateStateWorker(candidate);
    await fs.mkdir(plugin);
    await fs.symlink(plugin, locator, "dir");
    await fs.mkdir(path.join(modules, "dependency"), { recursive: true });
    await fs.writeFile(path.join(candidate, "retained.txt"), "candidate is not migration data");
    await fs.symlink(source.stateDir, path.join(candidate, "unrelated-live-alias"), "dir");
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({ name: "example", dependencies: { dependency: "*" } }),
    );
    await fs.writeFile(path.join(plugin, "index.js"), "export default {};\n");
    await fs.writeFile(path.join(modules, "dependency", "package.json"), '{"name":"dependency"}');
    await fs.symlink(candidate, path.join(modules, "openclaw"), "dir");
    await fs.symlink(modules, path.join(plugin, "node_modules"), "dir");
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: {
        installs: { example: { source: "path", sourcePath: locator, installPath: locator } },
      },
    };
    openOpenClawStateDatabase({ env: source.env });
    closeOpenClawStateDatabaseForTest();
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: source.stateDir,
      candidateRoot: candidate,
      env: source.env,
    });
    try {
      const params = {
        ...rehearsal,
        env: { ...rehearsal.env, OPENCLAW_UPDATE_IN_PROGRESS: "0" },
        assertCurrent() {},
      };
      const raw = await fs.readFile(rehearsal.configPath, "utf8");
      const copied: OpenClawConfig = JSON.parse(raw);
      const writeConfig = (overrides: Partial<OpenClawConfig>) =>
        fs.writeFile(rehearsal.configPath, JSON.stringify({ ...copied, ...overrides }));
      const alias = copied.plugins!.installs!.example!.installPath!;
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(
        (await fs.lstat(path.join(await fs.realpath(alias), "node_modules"))).isSymbolicLink(),
      ).toBe(true);
      const host = rehearsal.pluginCodeLinks!.find((fact) => fact.target?.path === candidate)!;
      expect(host).toBeDefined();
      const admitted = await inspectPreparedDoctorRehearsal(params);
      admitted.assertPrepared();

      // Code links cannot authorize data at the link or below it.
      for (const dataPath of [host.path, path.join(host.path, "retained.txt")]) {
        await writeConfig({ canvasHost: { root: dataPath } });
        await expect(inspectPreparedDoctorRehearsal(params)).rejects.toThrow(
          /unsafe ownership or links/,
        );
      }
      // Keep the raw traversal: path.join would erase the symlink/.. witness.
      const escaped = `${host.path}${path.sep}..${path.sep}live.sqlite`;
      const sentinel = path.join(root, "live.sqlite");
      await fs.writeFile(sentinel, "external state must not be admitted");
      // Win32 normalizes '..'; the admission refusals below still run everywhere.
      if (process.platform !== "win32") {
        expect(await fs.realpath(escaped)).toBe(sentinel);
      }
      for (const overrides of [
        { canvasHost: { root: escaped } },
        { plugins: { entries: { "voice-call": { config: { store: escaped } } } } },
        { plugins: { entries: { "memory-lancedb": { config: { dbPath: escaped } } } } },
        { plugins: { entries: { "memory-wiki": { config: { vault: { path: escaped } } } } } },
        { channels: { reef: { stateDir: escaped } } },
      ]) {
        await writeConfig(overrides);
        await expect(inspectPreparedDoctorRehearsal(params)).rejects.toThrow(/parent traversal/);
        expect(await fs.readFile(sentinel, "utf8")).toBe("external state must not be admitted");
      }
      await fs.writeFile(rehearsal.configPath, raw);
      const unowned = path.join(rehearsal.stateDir, "undeclared-data");
      await fs.symlink(path.join(rehearsal.stateDir, "workspace"), unowned, "dir");
      expect(() => admitted.assertPrepared()).toThrow(/unsafe ownership or links/);
      await fs.unlink(unowned);

      // Restore original inodes after replacing either the link or its target.
      for (const [target, replacement] of [
        [host.path, () => fs.symlink(path.join(rehearsal.stateDir, "workspace"), host.path, "dir")],
        [candidate, () => fs.mkdir(candidate)],
      ] as const) {
        const held = `${target}.held`;
        await fs.rename(target, held);
        try {
          await replacement();
          expect(() => admitted.assertPrepared()).toThrow(/code link changed/);
        } finally {
          if (target === candidate) {
            await fs.rmdir(target);
          } else {
            await fs.unlink(target);
          }
          await fs.rename(held, target);
        }
      }
      admitted.assertPrepared();
      expect(admitted.fact.kind).toBe("doctor-schema-rehearsal");
      expect(await fs.readFile(path.join(candidate, "retained.txt"), "utf8")).toBe(
        "candidate is not migration data",
      );
    } finally {
      await rehearsal.cleanup();
    }
  });
});
