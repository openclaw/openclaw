import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { prepareCandidateCommandEnv } from "../../src/infra/update-runner-git-commands.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("materializes patched Baileys with its own long edge and refreshes final dist imports", async () => {
  // Reuse the installed CAFS packages offline, never its mutable graph/payloads.
  const root = fs.realpathSync(createTempDir("openclaw-baileys-materialization-"));
  const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
  const write = (file: string, contents: string) =>
    fs.writeFileSync(path.join(root, file), contents);
  const json = (file: string, value: unknown) => write(file, JSON.stringify(value));
  const workspace = parse(read("pnpm-workspace.yaml"));
  const documents = pnpmLockfileDocuments(read("pnpm-lock.yaml"));
  const lock = parse(documents.dependencies);
  const installed = parse(read("node_modules/.modules.yaml"));
  const { packageManager } = JSON.parse(read("package.json"));
  const whatsapp = lock.importers["extensions/whatsapp"].dependencies;
  const dependencies: Record<string, { specifier: string; version: string }> = {
    baileys: whatsapp.baileys,
    "audio-decode": whatsapp["audio-decode"],
  };
  json("package.json", {
    private: true,
    type: "module",
    packageManager,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).map(([name, entry]) => [name, entry.specifier]),
    ),
  });
  write(
    "pnpm-lock.yaml",
    "---\n" +
      documents.environment +
      "\n---\n" +
      stringify({ ...lock, importers: { ".": { dependencies } } }),
  );
  for (const relative of Object.values(workspace.patchedDependencies) as string[]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), path.join(root, relative));
  }
  Object.assign(workspace, {
    packages: ["."],
    hoist: false,
    virtualStoreType: "global",
    // This offline fixture tests pinned payloads, not registry-age metadata.
    minimumReleaseAge: 0,
    minimumReleaseAgeStrict: false,
    packageImportMethod: "auto",
    storeDir: path.dirname(installed.storeDir),
  });
  const env = {
    ...process.env,
    CI: undefined,
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
    HOME: path.join(root, "home"),
    PNPM_CONFIG_VIRTUAL_STORE_TYPE: "global",
    pnpm_config_virtual_store_type: "global",
  };
  const command = async (argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    assert(argv[0], "fixture command requires an executable");
    const result = spawnSync(argv[0], argv.slice(1), {
      ...options,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) {
      throw result.error;
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const plugin = path.join(root, "extensions/whatsapp");
  fs.mkdirSync(path.join(plugin, "node_modules"), { recursive: true });
  write("extensions/whatsapp/index.ts", "export {};\n");
  json("extensions/whatsapp/package.json", {
    name: "@openclaw/whatsapp",
    type: "module",
    dependencies: { baileys: "7.0.0-rc14" },
    openclaw: {
      extensions: ["./index.ts"],
      build: { bundledDist: false },
      release: { publishToNpm: true },
    },
  });
  json("extensions/whatsapp/openclaw.plugin.json", {
    id: "whatsapp",
    configSchema: { type: "object" },
  });
  const distPlugin = path.join(root, "dist/extensions/whatsapp");
  const sibling = path.join(root, "dist/extensions/sibling/index.js");
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  write("dist/extensions/sibling/index.js", "preserve sibling");
  let previousTarget: string | undefined;
  for (const nodeLinker of ["isolated", "hoisted"]) {
    workspace.nodeLinker = nodeLinker;
    const original = stringify(workspace);
    write("pnpm-workspace.yaml", original);
    const prepared = await prepareCandidateCommandEnv("pnpm", env, root, command, 30_000);
    try {
      const install = await command(
        ["pnpm", "install", "--offline", "--ignore-scripts", "--frozen-lockfile"],
        { cwd: root, env: prepared.env },
      );
      expect(install.code, install.stderr + install.stdout).toBe(0);
      const source = fs.realpathSync(path.join(root, "node_modules/baileys"));
      const sourceLink = path.join(plugin, "node_modules/baileys");
      fs.rmSync(sourceLink, { force: true });
      fs.symlinkSync(source, sourceLink, "junction");
      if (previousTarget) {
        // An install changed topology after postbuild. The prior dist link is stale.
        expect(source).not.toBe(previousTarget);
      }
      copyBundledPluginMetadata({ repoRoot: root, pluginIds: new Set(["whatsapp"]) });
      const probe = await command(
        [
          resolveTestNodeExecPath(),
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
         import fs from "node:fs";
         import { createRequire } from "node:module";
         import { pathToFileURL } from "node:url";
         const require = createRequire(process.cwd() + "/probe.cjs");
         const entry = require.resolve("baileys");
         const baileysRequire = createRequire(entry);
         assert.equal(baileysRequire("long").fromString("9007199254740993").toString(), "9007199254740993");
         const { getAudioWaveform } = await import(entry);
         const wav = Buffer.alloc(44 + 4096 * 2);
         wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
         wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
         wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
         wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
         wav.writeUInt32LE(wav.length - 44, 40);
         for (let i = 0; i < 4096; i++) wav.writeInt16LE(Math.round(16000 * Math.sin(i / 10)), 44 + i * 2);
         const waveform = await getAudioWaveform(wav);
         assert.equal(waveform?.length, 64, "patched decoder must produce the voice-note waveform");
         assert.ok([...waveform].some(value => value > 0));
         assert.equal(await getAudioWaveform(Buffer.from("not audio")), undefined);
         const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", pathToFileURL(entry))));
         assert.equal(manifest.peerDependencies["audio-decode"], "^3.12.0");`,
        ],
        { cwd: distPlugin, env: prepared.env },
      );
      expect(probe.code, probe.stderr + probe.stdout).toBe(0);
      expect(fs.readFileSync(sibling, "utf8")).toBe("preserve sibling");
      previousTarget = source;
    } finally {
      await prepared.restoreWorkspace?.();
    }
    expect(fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(original);
  }
}, 60_000);
