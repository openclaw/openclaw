import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { stripNodeTypeScriptTypes } from "../helpers/node-toolchain.js";

/** Private compiler/type inputs; unrelated executable tool dependencies may stay shared. */
export function materializeDeclarationPackages(root: string, unified: boolean) {
  const locate = (name: string, from: string) => {
    const require = createRequire(path.join(from, "package.json"));
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return fs.realpathSync(candidate);
      }
    }
    throw new Error(`Missing fixture dependency ${name} from ${from}`);
  };
  const link = (target: string, destination: string) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(target, destination, "junction");
  };
  const copy = (name: string, from: string, destination: string, types: boolean) => {
    if (fs.existsSync(destination)) {
      return;
    }
    const source = locate(name, from);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    fs.cpSync(source, destination, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) => path.basename(file) !== "node_modules",
    });
    for (const dependency of Object.keys({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      const compilerPackage = ["typescript", "rolldown-plugin-dts"].includes(dependency);
      // Optional tool peers (e.g. Vue) are not part of this fixture's compiler graph.
      let dependencySource: string;
      try {
        dependencySource = locate(dependency, source);
      } catch {
        if (
          manifest.peerDependenciesMeta?.[dependency]?.optional ||
          manifest.optionalDependencies?.[dependency]
        ) {
          continue;
        }
        throw new Error(`Missing fixture dependency ${dependency} from ${name}`);
      }
      // One root compiler instance is shared by tsdown, its plugin, and receipts.
      // Physical private inputs keep cache relocation independent of junction targets.
      const target = path.join(compilerPackage ? root : destination, "node_modules", dependency);
      if (types || compilerPackage) {
        copy(dependency, source, target, types);
      } else {
        link(dependencySource, target);
      }
    }
  };
  // Physical package inputs keep relocation independent of absolute junction targets.
  // The build fence needs this real workspace helper before any package build.
  const normalizationCore = path.join(root, "node_modules/@openclaw/normalization-core");
  const normalizationSource = path.resolve("packages/normalization-core");
  const normalizationManifest = JSON.parse(
    fs.readFileSync(path.join(normalizationSource, "package.json"), "utf8"),
  );
  fs.mkdirSync(normalizationCore, { recursive: true });
  const errorCoercion = fs.readFileSync(
    path.join(normalizationSource, "src/error-coercion.ts"),
    "utf8",
  );
  fs.writeFileSync(path.join(normalizationCore, "error-coercion.ts"), errorCoercion);
  fs.writeFileSync(
    path.join(normalizationCore, "error-coercion.mjs"),
    stripNodeTypeScriptTypes(errorCoercion),
  );
  fs.writeFileSync(
    path.join(normalizationCore, "package.json"),
    JSON.stringify({
      name: normalizationManifest.name,
      version: normalizationManifest.version,
      type: "module",
      exports: {
        "./error-coercion": {
          types: "./error-coercion.ts",
          default: "./error-coercion.mjs",
        },
      },
    }),
  );
  for (const name of [
    "typescript",
    "tsdown",
    ...(unified ? ["@types/node", "apache-arrow"] : []),
  ]) {
    copy(name, process.cwd(), path.join(root, "node_modules", name), name !== "tsdown");
  }
}
