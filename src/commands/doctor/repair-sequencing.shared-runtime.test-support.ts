import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { on, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

export function registerSharedRuntimeReaderDoctorTests(): void {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([
    { selector: "STATE_DIRECTORY", sameInstall: false },
    { selector: "STATE_DIRECTORY", sameInstall: true },
    { selector: "OPENCLAW_PLUGIN_STAGE_DIR", sameInstall: false },
    { selector: "OPENCLAW_PLUGIN_STAGE_DIR", sameInstall: true },
  ])(
    "preserves a live shared runtime reader through Doctor ($selector, same install: $sameInstall)",
    async ({ selector, sameInstall }) => {
      const tempDir = tempDirs.make("openclaw-doctor-shared-runtime-");
      const inTemp = (...parts: string[]) => path.join(tempDir, ...parts);
      const stateA = inTemp(".openclaw");
      const stateB = inTemp(".openclaw-peer");
      const packageRoot = inTemp("prefix-a/node_modules/openclaw");
      const readerRoot = sameInstall ? packageRoot : inTemp("prefix-b/node_modules/openclaw");
      const sharedBase = inTemp(
        selector === "STATE_DIRECTORY"
          ? "shared/plugin-runtime-deps"
          : ".openclaw-install-stage-shared",
      );
      // Stable v2026.4.29 buckets are keyed by version and install path, not by
      // profile/database. Doctor cannot authorize deletion for another consumer.
      const packageHash = createHash("sha256").update(readerRoot).digest("hex").slice(0, 12);
      const bucket = path.join(sharedBase, `openclaw-2026.4.29-${packageHash}`);
      const dependency = path.join(bucket, "node_modules", "fixture-runtime-dependency");
      const mirror = path.join(bucket, "dist", "extensions", "fixture-reader");
      const alias = path.join(path.dirname(readerRoot), "fixture-runtime-dependency");
      const unknownFile = path.join(sharedBase, "unknown-consumer", "keep.txt");
      const databasePath = (stateDir: string) => path.join(stateDir, "state", "openclaw.sqlite");
      const runtimeEnv = (stateDir: string) => ({
        HOME: tempDir,
        USERPROFILE: tempDir,
        OPENCLAW_HOME: tempDir,
        OPENCLAW_STATE_DIR: stateDir,
        [selector]: selector === "STATE_DIRECTORY" ? path.dirname(sharedBase) : sharedBase,
      });
      const writeFiles = async (directory: string, files: Record<string, string>) => {
        await fs.mkdir(directory, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          await fs.writeFile(path.join(directory, name), content);
        }
      };
      const packageJson = (version: string) => JSON.stringify({ name: "openclaw", version });
      for (const stateDir of [stateA, stateB]) {
        await fs.mkdir(path.join(stateDir, "state"), { recursive: true });
        const database = new DatabaseSync(databasePath(stateDir));
        database.exec("PRAGMA user_version = 8");
        database.close();
      }
      for (const installRoot of new Set([packageRoot, readerRoot])) {
        await writeFiles(installRoot, { "package.json": packageJson("2026.4.29") });
      }
      await writeFiles(dependency, {
        "package.json": '{"main":"index.cjs"}\n',
        "index.cjs": 'exports.value = "dependency-ready";\n',
        "late.cjs": 'exports.value = "dependency-survived";\n',
      });
      await writeFiles(mirror, {
        "index.cjs":
          'exports.value = "mirror-ready"; exports.readLater = () => require("./late.cjs").value;\n',
        "late.cjs": 'exports.value = "mirror-survived";\n',
      });
      await writeFiles(path.dirname(unknownFile), { "keep.txt": "another consumer's files\n" });
      await fs.symlink(dependency, alias, "junction");
      const readerFile = inTemp("runtime-reader.cjs");
      await fs.writeFile(
        readerFile,
        `const [databasePath, packageRoot, modulePath] = process.argv.slice(2);
const database = new (require("node:sqlite").DatabaseSync)(databasePath, { readOnly: true });
const fromInstall = require("node:module").createRequire(require("node:path").join(packageRoot, "index.cjs"));
const mirror = require(modulePath);
const version = () => database.prepare("PRAGMA user_version").get().user_version;
process.on("message", (message) => {
  if (message === "close") {
    database.close();
    process.disconnect();
    return;
  }
  process.send(["read", version(), fromInstall("fixture-runtime-dependency/late.cjs").value, mirror.readLater()]);
});
process.send(["ready", version(), fromInstall("fixture-runtime-dependency").value, mirror.value]);
`,
      );
      const readerArgs = [databasePath(stateB), readerRoot, path.join(mirror, "index.cjs")];
      const reader = fork(readerFile, readerArgs, {
        cwd: stateB,
        execArgv: [],
        env: runtimeEnv(stateB),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const closed = once(reader, "close");
      const messages = on(reader, "message", { close: ["close"] });
      const expectMessage = async (kind: string, suffix: string) =>
        expect((await messages.next()).value?.[0]).toEqual([
          kind,
          8,
          `dependency-${suffix}`,
          `mirror-${suffix}`,
        ]);
      try {
        await expectMessage("ready", "ready");
        await fs.writeFile(path.join(packageRoot, "package.json"), packageJson("2026.8.1"));
        await runDoctorRepairSequence({
          state: { cfg: {}, candidate: {}, pendingChanges: false, fixHints: [] },
          doctorFixCommand: "openclaw doctor --fix",
          env: runtimeEnv(stateA),
        });
        reader.send("read");
        await expectMessage("read", "survived");
        expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(unknownFile, "utf8")).toBe("another consumer's files\n");
      } finally {
        if (reader.connected) {
          reader.send("close");
        }
        await expect(closed).resolves.toEqual([0, null]);
      }
    },
  );
}
