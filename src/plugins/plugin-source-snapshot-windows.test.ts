import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it.runIf(process.platform === "win32")(
  "loads real native images and case-insensitive members from a shared snapshot on Windows",
  () => {
    const stateDir = temporary.make("snapshot-native-windows-");
    const source = path.join(stateDir, "installed");
    const dependency = path.join(source, "node_modules", "MixedDependency");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "windows-snapshot", dependencies: { MixedDependency: "1" } }),
    );
    fs.writeFileSync(
      path.join(source, "Entry.cjs"),
      "exports.value=require('mixeddependency'); exports.native=require('./addon.node');",
    );
    fs.writeFileSync(path.join(dependency, "package.json"), '{"main":"Value.cjs"}');
    fs.writeFileSync(path.join(dependency, "Value.cjs"), "module.exports='captured-case';");
    const require = createRequire(import.meta.url);
    const grammarRoot = path.dirname(require.resolve("tree-sitter-bash/package.json"));
    fs.copyFileSync(
      path.join(
        grammarRoot,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "tree-sitter-bash.node",
      ),
      path.join(source, "Addon.node"),
    );
    const entrypoints = {
      capture: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceCapture).href,
      storage: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceCaptureContext).href,
      snapshot: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceSnapshot).href,
      native: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sharedSnapshotNative).href,
      loader: resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sharedSnapshotLoader).href,
    };
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import {createRequire} from 'node:module';
      import {capturePluginSourceSnapshot} from ${JSON.stringify(entrypoints.capture)};
      import {withPluginSourceCaptureStorage} from ${JSON.stringify(entrypoints.storage)};
      import {stagePluginSharedSourceSnapshot,acquirePluginSharedSourceSnapshot,collectPluginSourceSnapshots,pluginSourceSnapshotClosureDigest} from ${JSON.stringify(entrypoints.snapshot)};
      import {createPluginSharedSnapshotNativeLoader} from ${JSON.stringify(entrypoints.native)};
      import {createPluginSharedSnapshotModuleLoader} from ${JSON.stringify(entrypoints.loader)};
      const [stateDir,source]=process.argv.slice(1);
      const capture=withPluginSourceCaptureStorage({stateDir,placement:'state'},()=>capturePluginSourceSnapshot(source));
      const descriptor={...await stagePluginSharedSourceSnapshot({stateDir,capture,assertCurrent(){},binding:{installRecordHash:'record',contentDigest:capture.sourceDigest,dependencyClosureDigest:pluginSourceSnapshotClosureDigest(capture),buildResolutionDigest:'options'}}).then(p=>p.publish()),installedRevision:1};
      const snapshot=await acquirePluginSharedSourceSnapshot({stateDir,descriptor,assertCurrent(){}});
      const natives=[createPluginSharedSnapshotNativeLoader(snapshot),createPluginSharedSnapshotNativeLoader(snapshot)];
      const loaders=natives.map(native=>createPluginSharedSnapshotModuleLoader({snapshot,loadNativeModule:file=>native.load(file)}));
      const values=loaders.map(loader=>loader.requireModule(path.join(snapshot.rootDir,'entry.CJS')));
      if(values.some(value=>value.value!=='captured-case'||value.native.name!=='bash'||!value.native.language))throw new Error('Native or captured-case value differs');
      if(values[0].native===values[1].native)throw new Error('Native instances share exports');
      const hostRequire=createRequire(import.meta.url);
      const images=Object.keys(hostRequire.cache).filter(file=>file.startsWith(stateDir)&&file.toLowerCase().endsWith('.node'));
      if(images.length!==2||images.some(file=>!fs.existsSync(file)))throw new Error('Independent native images missing');
      loaders.forEach(loader=>loader.dispose());
      for(const native of natives)await native.disposeAsync();
      await snapshot.releaseAsync();
      await capture.disposeAsync();
      await collectPluginSourceSnapshots({stateDir,retiredSnapshots:[descriptor],retainedPaths:new Set(),assertCurrent(){}});
      if(images.some(file=>!fs.existsSync(file)))throw new Error('Mapped Windows images lost retention before process exit');
      console.log(JSON.stringify({platform:process.platform,arch:process.arch,value:values[0].value,native:values[0].native.name,independentImages:images.length,retainedUntilExit:true}));
    `;
    const runtime = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceSnapshot);
    const child = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(runtime).slice(0, -1),
        "--input-type=module",
        "-e",
        script,
        stateDir,
        source,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toMatchObject({
      platform: "win32",
      value: "captured-case",
      native: "bash",
      independentImages: 2,
      retainedUntilExit: true,
    });
  },
);
