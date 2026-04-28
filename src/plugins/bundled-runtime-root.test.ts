import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBundledRuntimeDependencyInstallRoot } from "./bundled-runtime-deps.js";
import { prepareBundledPluginRuntimeRoot } from "./bundled-runtime-root.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-runtime-root-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFilesystemTimestampTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isBigIntStatOptions(options: unknown): boolean {
  return Boolean(
    options && typeof options === "object" && "bigint" in options && options.bigint === true,
  );
}

describe("prepareBundledPluginRuntimeRoot", () => {
  it("materializes root JavaScript chunks in external mirrors", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "browser");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.24", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "pw-ai.js"),
      [
        `//#region extensions/browser/src/pw-ai.ts`,
        `import { marker } from "playwright-core";`,
        `export { marker };`,
        `//#endregion`,
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "shared-runtime.js"),
      "export const shared = 'mirrored-without-region';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "config-runtime.js"),
      "import JSON5 from 'json5'; export const parse = JSON5.parse;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../pw-ai.js"; export default { id: "browser", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/browser",
          version: "1.0.0",
          type: "module",
          dependencies: {
            "playwright-core": "1.0.0",
          },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    const depRoot = path.join(installRoot, "node_modules", "playwright-core");
    fs.mkdirSync(depRoot, { recursive: true });
    fs.writeFileSync(
      path.join(depRoot, "package.json"),
      JSON.stringify({
        name: "playwright-core",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(depRoot, "index.js"), "export const marker = 'stage-ok';\n", "utf8");

    const staleMirrorChunk = path.join(installRoot, "dist", "pw-ai.js");
    fs.mkdirSync(path.dirname(staleMirrorChunk), { recursive: true });
    fs.symlinkSync(path.join(packageRoot, "dist", "pw-ai.js"), staleMirrorChunk, "file");

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(path.join(installRoot, "dist", "extensions", "browser"));
    expect(prepared.modulePath).toBe(path.join(prepared.pluginRoot, "index.js"));
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);

    const preparedAgain = prepareBundledPluginRuntimeRoot({
      pluginId: "browser",
      pluginRoot: prepared.pluginRoot,
      modulePath: prepared.modulePath,
      env,
    });

    expect(preparedAgain).toEqual(prepared);
    expect(fs.existsSync(staleMirrorChunk)).toBe(true);
    expect(fs.lstatSync(staleMirrorChunk).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(staleMirrorChunk, "utf8")).toContain("playwright-core");
    expect(fs.lstatSync(path.join(installRoot, "dist", "shared-runtime.js")).isSymbolicLink()).toBe(
      false,
    );
    expect(fs.lstatSync(path.join(installRoot, "dist", "config-runtime.js")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("does not copy staged runtime mirror dist files onto themselves", () => {
    const stageDir = makeTempRoot();
    const installRoot = path.join(stageDir, "openclaw-2026.4.26-alpha");
    const pluginRoot = path.join(installRoot, "dist", "extensions", "qqbot");
    const distChunk = path.join(installRoot, "dist", "accounts-abc123.js");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.26", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(distChunk, "export const marker = 'same-root';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      `import { marker } from "../../accounts-abc123.js"; export default { id: "qqbot", marker };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(pluginRoot);
    expect(prepared.modulePath).toBe(path.join(pluginRoot, "index.js"));
    expect(fs.readFileSync(distChunk, "utf8")).toContain("same-root");
  });

  it("mirrors canonical dist chunks when loading from dist-runtime", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const canonicalPluginRoot = path.join(packageRoot, "dist", "extensions", "qqbot");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "qqbot");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(canonicalPluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageRoot, "dist", "onboard-abc123.js"),
      "export const setup = 'canonical-setup';\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "index.js"),
      `import { setup } from "../../onboard-abc123.js"; export default { id: "qqbot", setup };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "index.js"),
      [
        "export { default } ",
        "from ",
        JSON.stringify("../../../dist/extensions/qqbot/index.js"),
        ";\n",
      ].join(""),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    expect(prepared.pluginRoot).toBe(path.join(installRoot, "dist-runtime", "extensions", "qqbot"));
    expect(fs.existsSync(path.join(installRoot, "dist", "onboard-abc123.js"))).toBe(true);
    expect(
      fs.readFileSync(path.join(installRoot, "dist", "extensions", "qqbot", "index.js"), "utf8"),
    ).toContain("onboard-abc123");
  });

  it("fingerprints runtime mirror source roots before taking the mirror lock", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const canonicalPluginRoot = path.join(packageRoot, "dist", "extensions", "qqbot");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "qqbot");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(canonicalPluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "index.js"),
      "export default { id: 'qqbot' };\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "package.json"),
      JSON.stringify({ name: "@openclaw/qqbot", version: "1.0.0", type: "module" }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "index.js"),
      `export { default } from ${JSON.stringify("../../../dist/extensions/qqbot/index.js")};\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const lockPath = path.join(installRoot, ".openclaw-runtime-mirror.lock");
    const fingerprintLockStates: Array<{ source: "runtime" | "canonical"; locked: boolean }> = [];
    const realLstatSync = fs.lstatSync.bind(fs) as typeof fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target, options) => {
      const targetPath = target.toString();
      if (isBigIntStatOptions(options)) {
        if (isPathInsideRoot(targetPath, runtimePluginRoot)) {
          fingerprintLockStates.push({ source: "runtime", locked: fs.existsSync(lockPath) });
        } else if (isPathInsideRoot(targetPath, canonicalPluginRoot)) {
          fingerprintLockStates.push({ source: "canonical", locked: fs.existsSync(lockPath) });
        }
      }
      return realLstatSync(target, options as never);
    }) as typeof fs.lstatSync);

    prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    expect(fingerprintLockStates.some((entry) => entry.source === "runtime")).toBe(true);
    expect(fingerprintLockStates.some((entry) => entry.source === "canonical")).toBe(true);
    expect(fingerprintLockStates.filter((entry) => entry.locked)).toEqual([]);
  });

  it("reuses unchanged external runtime mirrors from the original plugin root", async () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v1';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          type: "module",
          dependencies: { "whatsapp-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "whatsapp-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "whatsapp-runtime", "package.json"),
      JSON.stringify({ name: "whatsapp-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const mirrorEntry = path.join(prepared.pluginRoot, "index.js");
    const initialStat = fs.statSync(mirrorEntry);

    await waitForFilesystemTimestampTick();

    const preparedAgain = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const reusedStat = fs.statSync(mirrorEntry);

    expect(preparedAgain).toEqual(prepared);
    expect(reusedStat.mtimeMs).toBe(initialStat.mtimeMs);
    expect(fs.readFileSync(mirrorEntry, "utf8")).toContain("v1");
  });

  it("regenerates wrappers in the staged dist-runtime tree so they resolve to the staged impl, not back to themselves", () => {
    // Repro for the read-only-source-tree crash-loop on Docker non-root
    // deployments: the wrapper at <openclaw>/dist-runtime/extensions/<plugin>/index.js
    // has a build-time-baked relative specifier `path.relative(wrapperDir,
    // implPath)` that points to <openclaw>/dist/extensions/<plugin>/index.js.
    // When mirrorBundledPluginRuntimeRoot copies that wrapper verbatim into
    // <installRoot>/dist-runtime/extensions/<plugin>/index.js, the specifier
    // (still computed relative to the SOURCE layout) resolves back to the
    // staged wrapper itself — a self-import that strips the
    // bundled-channel-entry contract from the wrapper's default export.
    //
    // After the fix, regenerateBundledPluginRuntimeWrappers rewrites the
    // staged wrapper using path.relative(stagedWrapperDir, stagedImplPath),
    // which correctly resolves to the staged impl.
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const canonicalPluginRoot = path.join(packageRoot, "dist", "extensions", "qqbot");
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "qqbot");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(canonicalPluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    // Canonical impl carries a sentinel string that proves the wrapper resolves
    // to the impl (not back to itself, which has no contract sentinel).
    const contractSentinel = "__bundled_channel_entry_contract__";
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "index.js"),
      `export const ${contractSentinel} = true;\nexport default { id: "qqbot" };\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(canonicalPluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    // Runtime wrapper as it would be emitted at build time. The relative
    // specifier here is correct for the SOURCE layout but resolves to the
    // wrong path once copied verbatim into the staged install root.
    fs.writeFileSync(
      path.join(runtimePluginRoot, "index.js"),
      `export * from ${JSON.stringify("../../../dist/extensions/qqbot/index.js")};\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/qqbot",
          version: "1.0.0",
          type: "module",
          dependencies: { "qqbot-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "qqbot-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "qqbot-runtime", "package.json"),
      JSON.stringify({ name: "qqbot-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    prepareBundledPluginRuntimeRoot({
      pluginId: "qqbot",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    const stagedWrapperPath = path.join(
      installRoot,
      "dist-runtime",
      "extensions",
      "qqbot",
      "index.js",
    );
    const stagedImplPath = path.join(installRoot, "dist", "extensions", "qqbot", "index.js");
    expect(fs.existsSync(stagedWrapperPath)).toBe(true);
    expect(fs.existsSync(stagedImplPath)).toBe(true);

    // Extract the wrapper's first relative-specifier (the `export *` line).
    const wrapperContent = fs.readFileSync(stagedWrapperPath, "utf8");
    const specifierMatch = wrapperContent.match(/^export \* from ["']([^"']+)["']/m);
    expect(specifierMatch, "wrapper must contain an export * from <specifier> line").toBeTruthy();
    const specifier = specifierMatch![1];

    // The specifier must resolve away from the wrapper itself: a self-import
    // is the exact bug the fix addresses.
    const resolvedFromWrapper = path.resolve(path.dirname(stagedWrapperPath), specifier);
    expect(resolvedFromWrapper).not.toBe(stagedWrapperPath);

    // And it must resolve to the staged impl, which carries the contract
    // sentinel.
    expect(resolvedFromWrapper).toBe(stagedImplPath);
    expect(fs.readFileSync(resolvedFromWrapper, "utf8")).toContain(contractSentinel);
  });

  it("leaves wrappers alone when no corresponding impl exists in the staged dist tree", () => {
    // Defensive: regeneration must only fire when the impl is actually
    // present at the expected staged path. Otherwise we'd risk overwriting
    // a wrapper that's already correct (or fabricating broken imports).
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const runtimePluginRoot = path.join(packageRoot, "dist-runtime", "extensions", "orphan");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    // No canonical dist tree for this plugin — only the runtime wrapper.
    const wrapperBefore = `export const orphan = true;\n`;
    fs.writeFileSync(path.join(runtimePluginRoot, "index.js"), wrapperBefore, "utf8");
    fs.writeFileSync(
      path.join(runtimePluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/orphan",
          version: "1.0.0",
          type: "module",
          dependencies: { "orphan-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(runtimePluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "orphan-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "orphan-runtime", "package.json"),
      JSON.stringify({ name: "orphan-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    prepareBundledPluginRuntimeRoot({
      pluginId: "orphan",
      pluginRoot: runtimePluginRoot,
      modulePath: path.join(runtimePluginRoot, "index.js"),
      env,
    });

    const stagedWrapperPath = path.join(
      installRoot,
      "dist-runtime",
      "extensions",
      "orphan",
      "index.js",
    );
    expect(fs.readFileSync(stagedWrapperPath, "utf8")).toBe(wrapperBefore);
  });

  it("refreshes external runtime mirrors when source files change", async () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "whatsapp");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.4.27", type: "module" }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v1';\n", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          type: "module",
          dependencies: { "whatsapp-runtime": "1.0.0" },
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    fs.mkdirSync(path.join(installRoot, "node_modules", "whatsapp-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(installRoot, "node_modules", "whatsapp-runtime", "package.json"),
      JSON.stringify({ name: "whatsapp-runtime", version: "1.0.0", type: "module" }),
      "utf8",
    );

    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const mirrorEntry = path.join(prepared.pluginRoot, "index.js");
    const initialStat = fs.statSync(mirrorEntry);

    await waitForFilesystemTimestampTick();
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const marker = 'v2';\n", "utf8");

    prepareBundledPluginRuntimeRoot({
      pluginId: "whatsapp",
      pluginRoot,
      modulePath: path.join(pluginRoot, "index.js"),
      env,
    });
    const refreshedStat = fs.statSync(mirrorEntry);

    expect(refreshedStat.mtimeMs).toBeGreaterThan(initialStat.mtimeMs);
    expect(fs.readFileSync(mirrorEntry, "utf8")).toContain("v2");
  });
});
