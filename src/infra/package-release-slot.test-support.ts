import fs from "node:fs";
import path from "node:path";

/** An owned npm prefix whose package path links to `releases/<id>`. */
export function createPackageReleasePrefixFixture(dir: string) {
  fs.mkdirSync(path.join(dir, "prefix"), { recursive: true });
  const prefix = fs.realpathSync.native(path.join(dir, "prefix"));
  const globalRoot = path.join(prefix, "lib", "node_modules");
  const slot = path.join(globalRoot, "openclaw");
  const binDir = path.join(prefix, "bin");
  const launcherTarget = "../lib/node_modules/openclaw/openclaw.mjs";
  fs.mkdirSync(globalRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(launcherTarget, path.join(binDir, "openclaw"));

  const writePackage = (root: string, version: string, build: string) => {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
    );
    fs.writeFileSync(
      path.join(root, "openclaw.mjs"),
      `export const version = ${JSON.stringify(version)};\n`,
    );
    fs.writeFileSync(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ buildId: build }),
    );
  };
  const releaseRoot = (id: string) =>
    path.join(prefix, "releases", id, "lib", "node_modules", "openclaw");
  const addRelease = (id: string, version: string, build = `build-${id}`) => {
    const root = releaseRoot(id);
    writePackage(root, version, build);
    const releaseBin = path.join(prefix, "releases", id, "bin");
    fs.mkdirSync(releaseBin, { recursive: true });
    fs.symlinkSync(launcherTarget, path.join(releaseBin, "openclaw"));
    return root;
  };
  const linkTo = (id: string) => {
    fs.rmSync(slot, { force: true });
    fs.symlinkSync(path.relative(globalRoot, releaseRoot(id)), slot);
  };
  return {
    prefix,
    globalRoot,
    slot,
    binDir,
    launcher: path.join(binDir, "openclaw"),
    releaseRoot,
    addRelease,
    linkTo,
    /** A plain package directory, as `install-cli.sh` and npm create it today. */
    writePlainPackage: (version: string, build = "build-plain") =>
      writePackage(slot, version, build),
  };
}
