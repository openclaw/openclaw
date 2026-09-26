import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUpdateCandidateRehearsal } from "../infra/update-candidate-rehearsal.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAppliedLegacyProposal } from "./doctor-skill-workshop-sqlite.test-support.js";
import { inspectPreparedDoctorRehearsal } from "./doctor-update-rehearsal-inventory.js";
import { collectDoctorSkillWorkshopBackupResources } from "./doctor-update-rehearsal-workshop.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("admits real producer plugin host, dependency and basename links without traversing the candidate", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (source) => {
    const root = dirs.make("rehearsal-plugin-source-");
    const candidate = path.join(root, "candidate");
    const plugin = path.join(root, "payload");
    const locator = path.join(root, "example");
    const modules = path.join(root, "modules");
    await fs.mkdir(candidate);
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
      const alias = copied.plugins!.installs!.example!.installPath!;
      expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
      expect(
        (await fs.lstat(path.join(await fs.realpath(alias), "node_modules"))).isSymbolicLink(),
      ).toBe(true);
      const host = rehearsal.pluginCodeLinks!.find((fact) => fact.target?.path === candidate)!;
      expect(host).toBeDefined();
      const admitted = await inspectPreparedDoctorRehearsal(params);
      admitted.assertPrepared();

      // A producer-owned code edge still cannot authorize migration data, either
      // at the link itself or through a descendant of that link.
      for (const dataPath of [host.path, path.join(host.path, "retained.txt")]) {
        await fs.writeFile(
          rehearsal.configPath,
          JSON.stringify({ ...copied, canvasHost: { root: dataPath } }),
        );
        await expect(inspectPreparedDoctorRehearsal(params)).rejects.toThrow(
          /unsafe ownership or links/,
        );
      }
      // Keep the raw traversal: path.join would erase the symlink/.. witness.
      const escaped = `${host.path}${path.sep}..${path.sep}live.sqlite`;
      const sentinel = path.join(root, "live.sqlite");
      await fs.writeFile(sentinel, "external state must not be admitted");
      // Node's Win32 binding normalizes .. before realpath; only POSIX preserves
      // this physical escape. The admission refusals below run on every platform.
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
        await fs.writeFile(rehearsal.configPath, JSON.stringify({ ...copied, ...overrides }));
        await expect(inspectPreparedDoctorRehearsal(params)).rejects.toThrow(/parent traversal/);
        expect(await fs.readFile(sentinel, "utf8")).toBe("external state must not be admitted");
      }
      await fs.writeFile(rehearsal.configPath, raw);
      const unowned = path.join(rehearsal.stateDir, "undeclared-data");
      await fs.symlink(path.join(rehearsal.stateDir, "workspace"), unowned, "dir");
      expect(() => admitted.assertPrepared()).toThrow(/unsafe ownership or links/);
      await fs.unlink(unowned);

      // Retargeting to another private directory is not permission to replace
      // the producer's exact code edge. Restore its inode, not a lookalike link.
      const heldLink = path.join(root, "held-link");
      await fs.rename(host.path, heldLink);
      try {
        await fs.symlink(path.join(rehearsal.stateDir, "workspace"), host.path, "dir");
        expect(() => admitted.assertPrepared()).toThrow(/code link changed/);
      } finally {
        await fs.unlink(host.path);
        await fs.rename(heldLink, host.path);
      }
      const heldCandidate = path.join(root, "held-candidate");
      await fs.rename(candidate, heldCandidate);
      try {
        await fs.mkdir(candidate);
        expect(() => admitted.assertPrepared()).toThrow(/code link changed/);
      } finally {
        await fs.rmdir(candidate);
        await fs.rename(heldCandidate, candidate);
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

it.each(["pending", "applied"] as const)(
  "admits real copied Workshop %s history without claiming external skill data",
  async (status) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (source) => {
      const skillDir = path.join(source.workspaceDir, "skills", "saved-procedure");
      const content = "# Saved procedure\n\nKeep the operator's current skill.\n";
      const applied = createAppliedLegacyProposal({
        id: "saved-procedure-20260901-1234567890",
        title: "Save procedure",
        description: "Keep a procedure",
        content,
        target: { skillKey: "saved-procedure", skillDir },
      });
      const record = {
        ...applied,
        status,
        appliedAt: status === "applied" ? applied.appliedAt : undefined,
        origin: { agentId: "main" },
      };
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content);
      await importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: source.env } });
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: source.workspaceDir } } },
      };
      closeOpenClawStateDatabaseForTest();
      const rehearsal = await prepareUpdateCandidateRehearsal({
        config,
        stateDir: source.stateDir,
        candidateRoot: source.root,
        env: source.env,
      });
      try {
        const copiedRecord = path.join(rehearsal.stateDir, "state", "openclaw.sqlite");
        const before = await fs.readFile(copiedRecord);
        await collectDoctorSkillWorkshopBackupResources({
          config: JSON.parse(await fs.readFile(rehearsal.configPath, "utf8")),
          env: { ...rehearsal.env, OPENCLAW_UPDATE_IN_PROGRESS: "0" },
        });
        expect(
          await fs.readFile(copiedRecord),
          "Workshop collector must preserve copied database bytes",
        ).toEqual(before);
        const admitted = await inspectPreparedDoctorRehearsal({
          ...rehearsal,
          env: { ...rehearsal.env, OPENCLAW_UPDATE_IN_PROGRESS: "0" },
          assertCurrent() {},
        });
        admitted.assertPrepared();
        expect(await fs.readFile(record.target.skillFile, "utf8")).toBe(content);
        expect(await fs.readFile(copiedRecord)).toEqual(before);
      } finally {
        await rehearsal.cleanup();
      }
    });
  },
);

it("releases copied Workshop readers before removing a rehearsal", async () => {
  const { openSqliteWorkerStore } = await import("../infra/sqlite-worker-store.js");
  const { closeOpenClawStateDatabaseByPathAsync } =
    await import("../state/openclaw-state-db-cache.js");
  await withOpenClawTestState({ scenario: "minimal" }, async (source) => {
    openOpenClawStateDatabase({ env: source.env });
    closeOpenClawStateDatabaseForTest();
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: {},
      stateDir: source.stateDir,
      candidateRoot: source.root,
      env: source.env,
    });
    const copied = path.join(rehearsal.stateDir, "state", "openclaw.sqlite");
    const retained = path.join(source.root, "retained-rehearsal.sqlite");
    const successor = path.join(source.root, "successor.sqlite");
    let store:
      | import("../infra/sqlite-worker-store.js").SqliteWorkerStore<
          import("../infra/sqlite-worker-store.test-support.js").FixtureOperations
        >
      | undefined;
    try {
      await collectDoctorSkillWorkshopBackupResources({
        config: {},
        env: { ...rehearsal.env, OPENCLAW_UPDATE_IN_PROGRESS: "0" },
      });
      await fs.link(copied, retained);
      await rehearsal.cleanup();
      await expect(fs.stat(copied)).rejects.toMatchObject({ code: "ENOENT" });
      // A real link preserves physical identity without depending on allocator inode reuse.
      store = await openSqliteWorkerStore<
        import("../infra/sqlite-worker-store.test-support.js").FixtureOperations
      >({
        moduleUrl: new URL("../infra/sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: successor,
        input: { type: "link", existingPath: retained },
      });
      await store.execute({ type: "append", input: { value: "after rehearsal cleanup" } });
      expect(await store.execute({ type: "read", input: undefined })).toEqual([
        "after rehearsal cleanup",
      ]);
    } finally {
      await store?.close();
      await closeOpenClawStateDatabaseByPathAsync(copied);
      await rehearsal.cleanup();
    }
  });
});
