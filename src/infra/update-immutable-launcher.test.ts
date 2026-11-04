import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { installImmutableLauncher } from "./update-immutable-generation.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "linux" && process.getuid?.() === 0)(
  "execs one physical generation and keeps lazy imports pinned after current changes, refusing an escaping pointer",
  async () => {
    const fixture = temporary.make("openclaw-immutable-launcher-");
    const root = path.join(fixture, "installation");
    fs.mkdirSync(root, { mode: 0o755 });
    const runtime = path.join(fixture, "node");
    fs.copyFileSync(process.execPath, runtime);
    fs.chownSync(runtime, 0, 0);
    fs.chmodSync(runtime, 0o755);
    const previous = path.join(root, "releases", "a".repeat(40));
    const next = path.join(root, "releases", "b".repeat(40));
    for (const { generation, value } of [
      { generation: previous, value: "previous" },
      { generation: next, value: "next" },
    ]) {
      fs.mkdirSync(path.join(generation, "dist"), { recursive: true, mode: 0o755 });
      fs.writeFileSync(path.join(generation, "package.json"), '{"type":"module"}');
      fs.writeFileSync(
        path.join(generation, "dist", "lazy.js"),
        `export default ${JSON.stringify(value)};`,
      );
    }
    fs.symlinkSync(previous, path.join(root, "current"));
    const payload = `
import fs from "node:fs";
fs.symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(path.join(root, "replacement"))});
fs.renameSync(${JSON.stringify(path.join(root, "replacement"))}, ${JSON.stringify(path.join(root, "current"))});
console.log(JSON.stringify({cwd: process.cwd(), entry: process.argv[1], args: process.argv.slice(2), lazy: (await import("./lazy.js")).default}));
`;
    fs.writeFileSync(path.join(previous, "dist", "index.js"), payload, { mode: 0o444 });
    const launcher = await installImmutableLauncher({ root, runtimePath: runtime });
    expect(await installImmutableLauncher({ root, runtimePath: runtime })).toBe(launcher);
    const launched = spawnSync(launcher, ["--port", "19547"], { encoding: "utf8" });
    expect(launched.stderr).not.toContain("Cannot start");
    expect(launched.status).toBe(0);
    expect(JSON.parse(launched.stdout)).toEqual({
      cwd: previous,
      entry: path.join(previous, "dist", "index.js"),
      args: ["gateway", "--port", "19547"],
      lazy: "previous",
    });
    expect(fs.realpathSync(path.join(root, "current"))).toBe(next);

    fs.unlinkSync(path.join(root, "current"));
    fs.symlinkSync(path.dirname(root), path.join(root, "current"));
    const refused = spawnSync(launcher, [], { encoding: "utf8" });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain("direct releases/<full-sha>");

    fs.writeFileSync(launcher, "foreign launcher\n");
    await expect(installImmutableLauncher({ root, runtimePath: runtime })).rejects.toThrow(
      "conflicts",
    );
    expect(fs.readFileSync(launcher, "utf8")).toBe("foreign launcher\n");
  },
);

const suiteTemporary = useAutoCleanupTempDirTracker(afterAll);
const fileIdentity = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

describe.runIf(process.platform === "linux" && process.getuid?.() === 0)(
  "immutable launcher activation admission",
  () => {
    let runtime: string;
    beforeAll(() => {
      runtime = fs.realpathSync(process.execPath);
      if (fs.statSync(runtime).uid !== 0) {
        runtime = path.join(suiteTemporary.make("immutable-launcher-runtime-"), "node");
        fs.copyFileSync(process.execPath, runtime);
        fs.chownSync(runtime, 0, 0);
        fs.chmodSync(runtime, 0o755);
      }
    });
    afterEach(() => vi.restoreAllMocks());

    async function setup(install = true) {
      const parent = temporary.make("immutable-launch-admission-");
      const root = path.join(parent, "installation");
      const oldSha = "a".repeat(40),
        nextSha = "b".repeat(40);
      for (const sha of [oldSha, nextSha]) {
        const generation = path.join(root, "releases", sha);
        fs.mkdirSync(path.join(generation, "dist"), { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(generation, "package.json"), '{"type":"module"}');
        fs.writeFileSync(
          path.join(generation, "dist", "index.js"),
          `console.log(${JSON.stringify(sha)});`,
          { mode: 0o444 },
        );
      }
      fs.symlinkSync(`releases/${oldSha}`, path.join(root, "current"));
      const control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
      const journal = path.join(control, "operation.sqlite");
      const launcher = path.join(root, "bin", "openclaw-gateway");
      if (install) {
        await installImmutableLauncher({ root, runtimePath: runtime });
      } else {
        fs.mkdirSync(path.dirname(launcher), { mode: 0o755 });
      }
      const generation = (sha: string) => ({
        sha,
        path: path.join(root, "releases", sha),
        identity: fileIdentity(path.join(root, "releases", sha)),
        buildDigest: "c".repeat(64),
      });
      const descriptor: ImmutableInstallDescriptor = {
        version: 2,
        activationEnabled: true,
        kind: "immutable",
        root,
        rootIdentity: fileIdentity(root),
        releasesIdentity: fileIdentity(path.join(root, "releases")),
        current: {
          ...generation(oldSha),
          pointerIdentity: fileIdentity(path.join(root, "current")),
        },
        runtime: { path: runtime, identity: "fixture-runtime" },
        service: {
          scope: "system",
          unit: "fixture.service",
          account: "fixture",
          stateDir: path.join(parent, "state"),
          configPath: path.join(parent, "state", "config.json"),
          profile: null,
        },
        source: "https://github.com/openclaw/openclaw.git",
      };
      const write = (activation: unknown, legacy = false) => {
        fs.mkdirSync(control, { mode: 0o755, recursive: true });
        const db = new DatabaseSync(journal);
        try {
          db.exec(
            `CREATE TABLE IF NOT EXISTS immutable_installation (slot INTEGER PRIMARY KEY, revision INTEGER NOT NULL, descriptor_json TEXT NOT NULL, prepared_json TEXT NOT NULL${legacy ? "" : ", activation_json TEXT NOT NULL"}) STRICT`,
          );
          db.prepare(
            legacy
              ? "INSERT OR REPLACE INTO immutable_installation VALUES (1, 0, ?, 'null')"
              : "INSERT OR REPLACE INTO immutable_installation VALUES (1, 0, ?, 'null', ?)",
          ).run(JSON.stringify(descriptor), ...(legacy ? [] : [JSON.stringify(activation)]));
        } finally {
          db.close();
        }
        fs.chmodSync(journal, 0o644);
      };
      const select = (sha: string) => {
        fs.unlinkSync(path.join(root, "current"));
        fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
        descriptor.current = {
          ...generation(sha),
          pointerIdentity: fileIdentity(path.join(root, "current")),
        };
      };
      const operation = (phase: string) => ({
        operation: {
          version: 1,
          operationId: "00000000-0000-4000-8000-000000000001",
          phase,
          authority: { installKey: root },
          previous: generation(oldSha),
          candidate: generation(nextSha),
        },
      });
      const launch = () => spawnSync(launcher, [], { encoding: "utf8", timeout: 5000 });
      return {
        root,
        control,
        journal,
        launcher,
        descriptor,
        oldSha,
        nextSha,
        write,
        select,
        operation,
        launch,
      };
    }

    it("gates supervisor replacements through durable stop phases until the owner authorizes startup", async () => {
      const f = await setup();
      for (const [phase, selected, allowed] of [
        ["prepared", f.oldSha, true],
        ["draining", f.oldSha, true],
        ["stopping", f.oldSha, false],
        ["stopped", f.oldSha, false],
        ["publishing", f.oldSha, false],
        ["starting", f.nextSha, true],
        ["verifying", f.nextSha, true],
        ["rollback-stopping", f.nextSha, false],
        ["rollback-publishing", f.nextSha, false],
        ["rollback-starting", f.oldSha, true],
        ["rolled-back", f.oldSha, true],
      ] as const) {
        f.select(selected);
        f.write(f.operation(phase));
        const result = f.launch();
        expect(result.status, `${phase}: ${result.stderr}`).toBe(allowed ? 0 : 78);
        expect(result.stdout.trim(), phase).toBe(allowed ? selected : "");
      }
    });

    it("fences a supervisor replacement after the original host exits before native stop dispatch", async () => {
      const f = await setup();
      const entry = path.join(f.descriptor.current.path, "dist", "index.js");
      fs.writeFileSync(
        entry,
        `console.log("Gateway admitted"); await new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });`,
      );
      fs.chmodSync(entry, 0o444);
      f.write(f.operation("draining"));
      const original = spawn(f.launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise<number | null>((resolve) => {
        original.once("close", resolve);
      });
      const started = new Promise<void>((resolve, reject) => {
        original.stdout.once("data", () => resolve());
        original.once("error", reject);
        original.once("exit", () => reject(new Error("Original fixture exited before admission")));
      });
      try {
        await started;
        // The real control marker is durable before the owned old process exits.
        f.write(f.operation("stopping"));
        original.stdin.end();
        expect(await closed).toBe(0);
        const replacement = f.launch();
        expect(replacement.status, replacement.stderr).toBe(78);
        expect(replacement.stdout).toBe("");
        f.write(f.operation("rollback-starting"));
        const authorized = f.launch();
        expect(authorized.status, authorized.stderr).toBe(0);
        expect(authorized.stdout.trim()).toBe("Gateway admitted");
      } finally {
        if (original.exitCode === null) {
          original.kill("SIGKILL");
        }
        await closed;
      }
    });

    it("preserves no-record and version-1 preparation launches across a bridge pointer change", async () => {
      const f = await setup();
      expect(f.launch().stdout.trim()).toBe(f.oldSha);
      f.descriptor.version = 1;
      delete f.descriptor.activationEnabled;
      f.write(null, true);
      fs.unlinkSync(path.join(f.root, "current"));
      fs.symlinkSync(`releases/${f.nextSha}`, path.join(f.root, "current"));
      const result = f.launch();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(f.nextSha);
    });

    it("admits a version-3 bridge while the published v2 launcher refuses before execution", async () => {
      const f = await setup();
      f.descriptor.version = 3;
      f.descriptor.releaseRetention = {
        version: 1,
        mode: "inspect",
        keepVerifiedGenerations: 3,
        pins: [],
      };
      f.write(null);
      const unsupported = f.launch();
      expect(unsupported.status).toBe(78);
      expect(unsupported.stdout).toBe("");
      fs.writeFileSync(
        path.join(f.descriptor.current.path, "package.json"),
        JSON.stringify({
          type: "module",
          openclaw: { immutableInstallDescriptorVersion: 3 },
        }),
      );
      const supported = f.launch();
      expect(supported.status, supported.stderr).toBe(0);
      expect(supported.stdout.trim()).toBe(f.oldSha);
      const oldLauncher = fs
        .readFileSync(
          new URL("../../test/fixtures/immutable-update/launcher-v2.mjs", import.meta.url),
          "utf8",
        )
        .replace(/^#![^\n]*\n/u, `#!${runtime}\n`);
      fs.writeFileSync(f.launcher, oldLauncher);
      const before = fs.readFileSync(f.journal);
      const refused = f.launch();
      expect(refused.status).toBe(78);
      expect(refused.stdout).toBe("");
      expect(fs.readFileSync(f.journal)).toEqual(before);
    });

    it("refuses malformed, unknown and mismatched version-2 startup state", async () => {
      const f = await setup();
      for (const activation of [
        [],
        { operation: null },
        f.operation("future-phase"),
        f.operation("recovery-required"),
        f.operation("starting"),
      ]) {
        f.write(activation);
        const result = f.launch();
        expect(result.status, result.stderr).toBe(78);
        expect(result.stdout).toBe("");
      }
      f.write(null);
      fs.unlinkSync(path.join(f.root, "current"));
      fs.symlinkSync(`releases/${f.nextSha}`, path.join(f.root, "current"));
      expect(f.launch().status).toBe(78);
      fs.unlinkSync(f.journal);
      const missing = f.launch();
      expect(missing.status, missing.stderr).toBe(78);
      expect(missing.stdout).toBe("");
    });

    it("refuses a hot activation journal without replaying or changing its source bytes", async () => {
      const f = await setup();
      f.write(f.operation("stopping"));
      createHotSqliteRollbackJournal({
        path: f.journal,
        mutationSql: "UPDATE immutable_installation SET activation_json='null'",
      });
      const before = [fs.readFileSync(f.journal), fs.readFileSync(`${f.journal}-journal`)];
      const result = f.launch();
      expect(result.status, result.stderr).toBe(78);
      expect(result.stdout).toBe("");
      expect([fs.readFileSync(f.journal), fs.readFileSync(`${f.journal}-journal`)]).toEqual(before);
    });

    it.each([1, 2] as const)(
      "upgrades only the exact opted-in v%i launcher and retains its original bytes",
      async (version) => {
        const f = await setup(false);
        const previous = fs
          .readFileSync(
            new URL(
              `../../test/fixtures/immutable-update/launcher-v${version}.mjs`,
              import.meta.url,
            ),
            "utf8",
          )
          .replace(/^#![^\n]*\n/u, `#!${runtime}\n`);
        fs.writeFileSync(f.launcher, previous, { mode: 0o755 });
        fs.mkdirSync(f.control, { mode: 0o755 });
        await expect(
          installImmutableLauncher({ root: f.root, runtimePath: runtime }),
        ).rejects.toThrow("conflicts");
        const oldIdentity = fileIdentity(f.launcher);
        await installImmutableLauncher({
          root: f.root,
          runtimePath: runtime,
          upgrade: { version, assertCurrent: () => {} },
        });
        expect(fileIdentity(f.launcher)).not.toBe(oldIdentity);
        expect(fs.readFileSync(path.join(f.control, `openclaw-gateway.v${version}`), "utf8")).toBe(
          previous,
        );
        f.write(f.operation("stopping"));
        expect(f.launch().status).toBe(78);
        const current = fs.readFileSync(f.launcher);
        await installImmutableLauncher({
          root: f.root,
          runtimePath: runtime,
          upgrade: { version, assertCurrent: () => {} },
        });
        expect(fs.readFileSync(f.launcher)).toEqual(current);
      },
    );

    it.each([1, 2] as const)(
      "preserves an unknown launcher despite explicit v%i upgrade authorization",
      async (version) => {
        const f = await setup(false);
        const previous = `#!${runtime}\n// custom operator launcher\n`;
        fs.writeFileSync(f.launcher, previous, { mode: 0o755 });
        fs.mkdirSync(f.control, { mode: 0o755 });
        await expect(
          installImmutableLauncher({
            root: f.root,
            runtimePath: runtime,
            upgrade: { version, assertCurrent: () => {} },
          }),
        ).rejects.toThrow(`known v${version} upgrade`);
        expect(fs.readFileSync(f.launcher, "utf8")).toBe(previous);
        expect(fs.readdirSync(f.control)).toEqual([]);
      },
    );

    it("keeps the original launcher when upgrade authority is revoked after backup publication", async () => {
      const f = await setup(false);
      const previous = fs
        .readFileSync(
          new URL("../../test/fixtures/immutable-update/launcher-v1.mjs", import.meta.url),
          "utf8",
        )
        .replace(/^#![^\n]*\n/u, `#!${runtime}\n`);
      fs.writeFileSync(f.launcher, previous, { mode: 0o755 });
      fs.mkdirSync(f.control, { mode: 0o755 });
      let current = true;
      const rename = fs.renameSync;
      vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        rename(source, destination);
        if (String(destination) === path.join(f.control, "openclaw-gateway.v1")) {
          current = false;
        }
      });
      await expect(
        installImmutableLauncher({
          root: f.root,
          runtimePath: runtime,
          upgrade: {
            version: 1,
            assertCurrent: () => {
              if (!current) {
                throw new Error("upgrade authority ended");
              }
            },
          },
        }),
      ).rejects.toThrow("upgrade authority ended");
      expect(fs.readFileSync(f.launcher, "utf8")).toBe(previous);
      expect(fs.readFileSync(path.join(f.control, "openclaw-gateway.v1"), "utf8")).toBe(previous);
    });
  },
);
