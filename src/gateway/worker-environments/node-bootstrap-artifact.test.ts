import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { collectPackageDistInventory } from "../../infra/package-dist-inventory.js";
import * as tmpDirs from "../../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  buildId,
  longEntryPath,
  longEntryPayload,
  useNodeBootstrapArtifactFixtures,
  version,
  write,
  writeBundledBrowser,
  writeOwnedChunks,
  type OwnedRuntimeChunk,
} from "./node-bootstrap-artifact.test-support.js";

const { fixture, tempDirs } = useNodeBootstrapArtifactFixtures();

describe("node bootstrap distribution", () => {
  it("preserves an installed bundled dependency's runtime layout and assets", async () => {
    const { root, packageRoot, provider } = await fixture();
    const browserRoot = await writeBundledBrowser(packageRoot);
    await write(browserRoot, ".env", "FAKE_PRIVATE_VALUE=do-not-transfer");
    await write(root, "nested-native/host-native", "do-not-transfer-native");
    await fs.symlink(
      path.join(root, "nested-native"),
      path.join(browserRoot, "node_modules"),
      "junction",
    );
    await write(
      packageRoot,
      "dist/entry.js",
      'import { notice } from "@fixture/browser"; console.log(notice);',
    );
    const artifact = await provider.prepare();
    const installed = path.join(root, "node");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    const target = path.join(installed, "package");
    for (const relative of [".env", "node_modules"]) {
      await expect(
        fs.access(path.join(target, "node_modules/@fixture/browser", relative)),
      ).rejects.toHaveProperty("code", "ENOENT");
    }
    for (const entry of [
      "openclaw.mjs",
      "node_modules/@fixture/browser/build/src/bin/browser.js",
    ]) {
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(target, entry)]);
      expect(stdout.trim()).toBe("bundled-notice");
    }
    for (const [relative, contents] of [
      ["build/src/OPENCLAW_PATCH_NOTICE.md", "patched-runtime"],
      ["skills/browser/SKILL.md", "browser-skill"],
      ["LICENSE", "fixture-license"],
    ]) {
      expect(
        await fs.readFile(path.join(target, "node_modules/@fixture/browser", relative!), "utf8"),
      ).toBe(contents);
    }
  });

  it.each(["source", "package", "external-plugin", "linked-package"] as const)(
    "runs an unpublished %s snapshot with its plugin and private JavaScript dependency",
    async (mode) => {
      const { root, packageRoot, provider, sourcePackage } = await fixture(mode);
      const privateChunks: Record<string, OwnedRuntimeChunk> =
        mode === "source"
          ? {
              "opaque-A1b2C3.mjs": {
                source: 'import "./opaque-D4e5F6.mjs";\n',
                extensions: ["qa-lab"],
              },
              "opaque-D4e5F6.mjs": {
                source: 'import "./qa-runtime-private.mjs";\n',
                extensions: ["qa-channel", "qa-lab"],
              },
            }
          : {};
      if (mode === "source") {
        await writeOwnedChunks(packageRoot, privateChunks);
        await write(packageRoot, "dist/qa-runtime-private.mjs", "export {};\n");
      }
      const sourceOwnership =
        mode === "source"
          ? await fs.readFile(
              path.join(packageRoot, "dist/runtime-dependency-ownership.json"),
              "utf8",
            )
          : undefined;
      // Node's getter temporarily changes the process mask and races parallel file creation.
      const readUmask = vi.spyOn(process, "umask").mockImplementation(() => {
        throw new Error("Artifact preparation must not read or mutate the process umask");
      });
      const [artifact, concurrent] = await Promise.all([
        provider.prepare(),
        provider.prepare(),
      ]).finally(() => readUmask.mockRestore());
      expect(concurrent).toBe(artifact);
      expect(artifact).toMatchObject({
        buildId,
        openclawVersion: version,
        enabledPluginIds: ["remote-runtime"],
      });
      const bytes = await fs.readFile(artifact.tarballPath);
      expect(bytes.byteLength).toBe(artifact.tarballBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.tarballSha256);
      const installed = path.join(root, "node");
      await fs.mkdir(installed);
      const entries: string[] = [];
      const modes = new Map<string, number | undefined>();
      await tar.extract({
        file: artifact.tarballPath,
        cwd: installed,
        onReadEntry: (entry) => {
          entries.push(entry.path);
          modes.set(entry.path, entry.mode);
        },
      });
      expect(
        entries.some((entry) =>
          /(?:\.env|private\.ts|host-native|\.map|\.buildstamp)$/u.test(entry),
        ),
      ).toBe(false);
      expect(entries.some((entry) => entry.startsWith("package/dist/worker/"))).toBe(false);
      expect(entries.some((entry) => entry.startsWith("package/dist/control-ui/"))).toBe(false);
      for (const [file, chunk] of Object.entries(privateChunks)) {
        expect(entries).not.toContain(`package/dist/${file}`);
        expect(await fs.readFile(path.join(packageRoot, "dist", file), "utf8")).toBe(chunk.source);
      }
      if (mode === "source") {
        expect(entries).not.toContain("package/dist/qa-runtime-private.mjs");
        expect(
          await fs.readFile(path.join(packageRoot, "dist/qa-runtime-private.mjs"), "utf8"),
        ).toBe("export {};\n");
        expect(
          await fs.readFile(
            path.join(packageRoot, "dist/runtime-dependency-ownership.json"),
            "utf8",
          ),
        ).toBe(sourceOwnership);
      }
      expect(await collectPackageDistInventory(packageRoot)).toEqual(
        expect.arrayContaining(["dist/control-ui/index.html", "dist/control-ui/assets/app.js"]),
      );
      if (process.platform !== "win32") {
        for (const [relative, requestedMode] of [
          ["openclaw.mjs", 0o755],
          ["dist/shared.js", 0o644],
        ] as const) {
          const sourceMode = (await fs.stat(path.join(packageRoot, relative))).mode;
          expect(modes.get(`package/${relative}`)).toBe(sourceMode & requestedMode);
        }
      }
      if (mode === "external-plugin") {
        expect(entries).not.toContain("package/dist/extensions/remote-runtime/index.js");
      }
      const target = path.join(installed, "package");
      expect(await fs.readFile(path.join(target, "dist/empty.js"), "utf8")).toBe("");
      expect(JSON.parse(await fs.readFile(path.join(target, longEntryPath), "utf8"))).toEqual({
        payload: longEntryPayload,
      });
      const manifest = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf8"));
      expect(manifest.dependencies).toEqual({ "@fixture/ai": version, "native-runtime": "1.2.3" });
      expect(manifest.bundleDependencies).toEqual(["@fixture/ai"]);
      expect(manifest.scripts).toEqual({
        preinstall: "node scripts/preinstall.mjs",
        postinstall: "node scripts/postinstall.mjs",
      });
      expect(manifest.devDependencies).toBeUndefined();
      const lifecycleMarker = path.join(target, ".openclaw-lifecycle-pending");
      await expect(fs.readFile(lifecycleMarker, "utf8")).resolves.toBe("pending\n");
      await promisify(execFile)(process.execPath, [path.join(target, "scripts/preinstall.mjs")]);
      await expect(fs.readFile(lifecycleMarker, "utf8")).resolves.toBe("pending\n");
      await promisify(execFile)(process.execPath, [path.join(target, "scripts/postinstall.mjs")]);
      await expect(fs.access(lifecycleMarker)).rejects.toHaveProperty("code", "ENOENT");
      const { stdout } = await promisify(execFile)(process.execPath, [
        path.join(target, "openclaw.mjs"),
      ]);
      expect(stdout.trim()).toBe("local-ai:cloud-ready");
      expect(JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"))).toEqual(
        sourcePackage,
      );
      expect(
        await fs.readFile(
          path.join(
            packageRoot,
            "dist/extensions/remote-runtime/node_modules/native-runtime/vendor/host-native",
          ),
          "utf8",
        ),
      ).toBe("do-not-transfer-native");
      await provider.close();
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(provider.prepare()).rejects.toThrow("closed");
    },
  );

  it.each([
    {
      name: "shared plugin ownership",
      extensions: ["qa-lab", "remote-runtime"],
      entry: "ownership",
    },
    { name: "public plugin ownership", extensions: ["remote-runtime"], entry: "ownership" },
    { name: "a current root import", extensions: ["qa-lab"], entry: "root" },
    { name: "a current root createRequire", extensions: ["qa-lab"], entry: "require" },
    { name: "a transitive current root import", extensions: ["qa-lab"], entry: "transitive" },
    { name: "the CLI launcher", extensions: ["qa-lab"], entry: "launcher" },
    { name: "a declared install script", extensions: ["qa-lab"], entry: "install" },
  ])("retains complete runtime chunks required by $name", async ({ extensions, entry }) => {
    const { root, packageRoot, provider } = await fixture();
    const chunks = {
      "opaque-A1b2C3.mjs": {
        source: 'export { retained } from "./opaque-D4e5F6.mjs";\n',
        extensions,
      },
      "opaque-D4e5F6.mjs": { source: "export const retained = true;\n", extensions },
    };
    await writeOwnedChunks(packageRoot, chunks);
    const importer =
      entry === "launcher"
        ? "openclaw.mjs"
        : entry === "install"
          ? "scripts/preinstall.mjs"
          : "dist/entry.js";
    const original = await fs.readFile(path.join(packageRoot, importer), "utf8");
    const importSource =
      entry === "ownership"
        ? ""
        : entry === "require"
          ? 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./opaque-A1b2C3.mjs");\n'
          : entry === "transitive"
            ? 'import "./bridge.js";\n'
            : entry === "launcher"
              ? 'await import(new URL("./dist/opaque-A1b2C3.mjs", import.meta.url));\n'
              : entry === "install"
                ? 'await import(new URL("../dist/opaque-A1b2C3.mjs", import.meta.url));\n'
                : 'import "./opaque-A1b2C3.mjs";\n';
    await write(packageRoot, importer, importSource + original);
    if (entry === "transitive") {
      await write(packageRoot, "dist/bridge.js", 'import "./opaque-A1b2C3.mjs";\n');
    }
    const artifact = await provider.prepare();
    const installed = path.join(root, "node");
    await fs.mkdir(installed);
    await tar.extract({ file: artifact.tarballPath, cwd: installed });
    if (entry === "install") {
      await promisify(execFile)(process.execPath, [
        path.join(installed, "package/scripts/preinstall.mjs"),
      ]);
    }
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(installed, "package/openclaw.mjs"),
    ]);
    expect(stdout.trim()).toBe("local-ai:cloud-ready");
    for (const [file, chunk] of Object.entries(chunks)) {
      expect(await fs.readFile(path.join(installed, "package/dist", file), "utf8")).toBe(
        chunk.source,
      );
    }
  });

  it.each([
    { metadata: "stale", error: /ownership.*match/u },
    { metadata: "malformed", error: /ownership artifact/u },
    { metadata: "missing", error: /incomplete built import closure/u },
  ])("refuses private runtime omission with $metadata ownership", async ({ metadata, error }) => {
    const { packageRoot, provider } = await fixture();
    const source = 'import "./qa-runtime-private.mjs";\n';
    await writeOwnedChunks(packageRoot, {
      "opaque-A1b2C3.mjs": { source, extensions: ["qa-lab"] },
    });
    await write(packageRoot, "dist/qa-runtime-private.mjs", "export {};\n");
    if (metadata === "stale") {
      await write(packageRoot, "dist/opaque-A1b2C3.mjs", `${source}export const changed = true;\n`);
    } else if (metadata === "malformed") {
      await write(packageRoot, "dist/runtime-dependency-ownership.json", { chunks: [] });
    } else {
      await fs.rm(path.join(packageRoot, "dist/runtime-dependency-ownership.json"));
    }
    await expect(provider.prepare()).rejects.toThrow(error);
  });

  it("rejects a retained entry changed after import inspection and removes its archive", async () => {
    const { packageRoot, provider } = await fixture();
    await writeOwnedChunks(packageRoot, {
      "opaque-A1b2C3.mjs": {
        source: 'import "./qa-runtime-private.mjs";\n',
        extensions: ["qa-lab"],
      },
    });
    await write(packageRoot, "dist/qa-runtime-private.mjs", "export {};\n");
    const entryPath = path.join(packageRoot, "dist/entry.js");
    const original = await fs.readFile(entryPath, "utf8");
    const openFile = fs.open.bind(fs);
    const makeTemp = fs.mkdtemp.bind(fs);
    let entryReads = 0;
    let changed = false;
    let artifactRoot: string | undefined;
    const destination = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (...args) => {
      artifactRoot = await makeTemp(...args);
      return artifactRoot;
    });
    const reader = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === entryPath) {
        entryReads += 1;
      }
      // The first open inspects imports; the second reads the bytes for the archive.
      if (args[0] === entryPath && entryReads === 2) {
        changed = true;
        await fs.writeFile(entryPath, `import "./opaque-A1b2C3.mjs";\n${original}`);
      }
      return await openFile(...args);
    });
    try {
      await expect(provider.prepare()).rejects.toThrow("changed after import inspection");
      expect(changed).toBe(true);
      expect(entryReads).toBe(2);
      expect(artifactRoot).toBeDefined();
      await expect(fs.access(artifactRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reader.mockRestore();
      destination.mockRestore();
    }
  });

  it("rejects stale running build identity before transferring a same-version distribution", async () => {
    const { packageRoot, provider } = await fixture();
    await write(packageRoot, "dist/build-info.json", { version, buildId: "newer-build" });
    await expect(provider.prepare()).rejects.toThrow("running Gateway build");
    await write(packageRoot, "dist/build-info.json", { version, buildId });
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it.each(["root resolution", "staging creation"])(
    "retries preparation after temporary %s becomes available",
    async (stage) => {
      const { provider } = await fixture();
      const failure = new Error("temporary storage unavailable");
      const makeTemp =
        stage === "root resolution"
          ? vi.spyOn(tmpDirs, "resolvePreferredOpenClawTmpDir").mockImplementationOnce(() => {
              throw failure;
            })
          : vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(failure);
      try {
        await expect(provider.prepare()).rejects.toThrow("temporary storage unavailable");
      } finally {
        makeTemp.mockRestore();
      }
      await expect(provider.prepare()).resolves.toMatchObject({ buildId });
    },
  );

  it("joins a failed archive output and removes it before a successful retry", async () => {
    const { provider } = await fixture();
    const makeTemp = fs.mkdtemp.bind(fs);
    let failedRoot: string | undefined;
    const destination = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (...args) => {
      failedRoot = await makeTemp(...args);
      await fs.mkdir(path.join(failedRoot, "node-runtime.tgz"));
      return failedRoot;
    });
    try {
      await expect(provider.prepare()).rejects.toThrow();
      expect(failedRoot).toBeDefined();
      await expect(fs.access(failedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      destination.mockRestore();
    }
    await expect(provider.prepare()).resolves.toMatchObject({ buildId });
  });

  it("does not return an artifact when its lifecycle closes during preparation", async () => {
    const { provider } = await fixture();
    const pending = provider.prepare();
    const closing = provider.close();
    await expect(pending).rejects.toThrow("closed");
    await closing;
  });

  it("keeps a retired artifact until its active enrollment closes", async () => {
    const { provider } = await fixture();
    const enrollment = new AbortController();
    const artifact = await provider.prepare(enrollment.signal);
    const closing = provider.close();
    try {
      await expect(fs.access(artifact.tarballPath)).resolves.toBeUndefined();
      await expect(provider.prepare()).rejects.toThrow("closed");
    } finally {
      enrollment.abort();
      await closing;
    }
    await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels one waiting enrollment without abandoning shared artifact preparation", async () => {
    const { provider } = await fixture();
    const stagingRoot = tempDirs.make("node-artifact-held-");
    const entered = createDeferredCore();
    const resume = createDeferredCore<string>();
    const makeTemp = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async () => {
      entered.resolve();
      return await resume.promise;
    });
    const enrollment = new AbortController();
    const completed = vi.fn();
    const pending = provider.prepare(enrollment.signal).then(
      (artifact) => completed({ artifact }),
      (error: unknown) => completed({ error }),
    );
    const retained = provider.prepare();
    try {
      await entered.promise;
      enrollment.abort(new DOMException("enrollment cancelled", "AbortError"));
      await vi.waitFor(() =>
        expect(completed).toHaveBeenCalledExactlyOnceWith({
          error: expect.objectContaining({ name: "AbortError" }),
        }),
      );
      expect(makeTemp).toHaveBeenCalledOnce();
      resume.resolve(stagingRoot);
      const artifact = await retained;
      expect(await provider.prepare()).toBe(artifact);
      expect(makeTemp).toHaveBeenCalledOnce();
      await provider.close();
      await expect(fs.access(artifact.tarballPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume.resolve(stagingRoot);
      await Promise.allSettled([pending, retained]);
      makeTemp.mockRestore();
    }
  });

  it.each(["plugin", "private runtime", "bundled runtime"])(
    "rejects an incomplete %s import closure before publishing the artifact",
    async (owner) => {
      const { packageRoot, provider } = await fixture();
      if (owner === "plugin") {
        await fs.rm(path.join(packageRoot, "dist/shared.js"));
      } else if (owner === "bundled runtime") {
        const browserRoot = await writeBundledBrowser(packageRoot);
        await write(browserRoot, "build/src/transport.js", 'import "./missing.js";');
        await fs.appendFile(
          path.join(browserRoot, "build/src/index.js"),
          'import "./transport.js";',
        );
      } else {
        const aiRoot = await fs.realpath(path.join(packageRoot, "node_modules/@fixture/ai"));
        await write(aiRoot, "dist/index.js", 'export { name } from "./missing.js";');
      }
      await expect(provider.prepare()).rejects.toThrow("incomplete built import closure");
    },
  );

  it("rejects source/built plugin dependency drift and nonexact native pins", async () => {
    const { packageRoot, provider, pluginPackage } = await fixture();
    const changed = { ...pluginPackage, dependencies: { "native-runtime": "^1.3.0" } };
    await write(packageRoot, "extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("does not match source metadata");
    await write(packageRoot, "dist/extensions/remote-runtime/package.json", changed);
    await expect(provider.prepare()).rejects.toThrow("requires an exact dependency pin");
  });

  it.each(["Gateway", "bundled dependency"])(
    "rejects a link escaping the %s tree without reading the target into the artifact",
    async (owner) => {
      const { root, packageRoot, provider } = await fixture();
      await write(root, "private.json", { secret: "fixture-only" });
      const destination =
        owner === "Gateway"
          ? path.join(packageRoot, "dist/private.json")
          : path.join(await writeBundledBrowser(packageRoot), "build/src/private.json");
      await fs.symlink(path.join(root, "private.json"), destination);
      await expect(provider.prepare()).rejects.toThrow(
        owner === "Gateway" ? "Unsafe package dist path" : "Unsafe bundled node distribution path",
      );
    },
  );

  it("gives different archive identities to different built bytes with the same package version", async () => {
    const first = await fixture();
    const second = await fixture();
    await write(
      second.packageRoot,
      "dist/shared.js",
      'export const answer = "dirty-source-build";',
    );
    const [left, right] = await Promise.all([first.provider.prepare(), second.provider.prepare()]);
    expect(left.openclawVersion).toBe(right.openclawVersion);
    expect(left.tarballSha256).not.toBe(right.tarballSha256);
  });

  it("rejects streamed bytes that differ from the verified source", async () => {
    const { provider } = await fixture();
    // oxlint-disable-next-line typescript/unbound-method -- Fault injection reapplies the original ReadEntry receiver below.
    const writeEntry = tar.ReadEntry.prototype.write;
    let substituted = false;
    const writer = vi.spyOn(tar.ReadEntry.prototype, "write").mockImplementation(function (
      this: tar.ReadEntry,
      chunk,
    ) {
      if (this.path === "package/dist/shared.js") {
        substituted = true;
        return writeEntry.call(this, Buffer.alloc(chunk.length, 0x20));
      }
      return writeEntry.call(this, chunk);
    });
    try {
      await expect(provider.prepare()).rejects.toThrow(
        "Node bootstrap archive does not match the verified distribution",
      );
      expect(substituted).toBe(true);
    } finally {
      writer.mockRestore();
    }
  });
});
