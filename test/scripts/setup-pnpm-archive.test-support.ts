import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const owner = ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs";
const wrapperAnchor =
  "37536c26ed40ab4134b6511e09f6b27f3ebb45687468f2406ca3805279a4e5ca158c1931350ad9774d6ab2108d71b3dbaeb39943159294375e4d053e8e05685c";
const nativeAnchor =
  "490560464711e17caa7fcf9535bb58d2bb5c1277c3ab8f11847df41d6a36fd47ea2847e57b6ace3321993a63750db330e19cc6e66598a02f353bb66a1c565c3f";

export function createPnpmArchiveFixture(
  tempDirs: { make(prefix: string): string },
  options: { platform?: string; arch?: string; glibc?: boolean } = {},
) {
  const root = tempDirs.make("pnpm-verified-download-");
  const image = path.join(root, "image");
  const registry = path.join(root, "registry");
  const runner = path.join(root, "runner");
  const storeDir = path.join(root, "store");
  const bin = path.join(root, "bin");
  for (const dir of [image, registry, runner, bin, storeDir]) {
    fs.mkdirSync(dir);
  }
  const store = fs.realpathSync.native(storeDir);
  function archive(name: string, native: boolean) {
    const stage = path.join(root, native ? "native" : "wrapper");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "12.4.0" }));
    fs.writeFileSync(path.join(stage, "pnpm"), native ? "native-fixture\n" : "wrapper-fixture\n");
    const dest = path.join(registry, name);
    execFileSync("tar", ["-czf", dest, "-C", root, path.basename(stage)]);
    return createHash("sha512").update(fs.readFileSync(dest)).digest("hex");
  }
  const wrapperHash = archive("pnpm-12.4.0.tgz", false);
  const nativeHash = archive("exe.linux-x64-12.4.0.tgz", true);
  const calls = path.join(root, "curl-calls");
  const curl = path.join(bin, "curl");
  fs.writeFileSync(
    curl,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CURL_CALLS"
if [ "\${CURL_FIXTURE_EXIT:-0}" != 0 ]; then exit "$CURL_FIXTURE_EXIT"; fi
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then shift; out="$1"; fi
  url="$1"
  shift
done
case "$url" in
  https://registry.npmjs.org/pnpm/-/pnpm-12.4.0.tgz) name=pnpm-12.4.0.tgz ;;
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.4.0.tgz) name=exe.linux-x64-12.4.0.tgz ;;
  *) exit 91 ;;
esac
cp "$FIXTURE_REGISTRY/$name" "$out"
`,
    { mode: 0o755 },
  );
  const script = fs
    .readFileSync(owner, "utf8")
    .replaceAll("/opt/crabbox/toolchain-archives", image)
    .replaceAll("process.platform", JSON.stringify(options.platform ?? "linux"))
    .replaceAll("process.arch", JSON.stringify(options.arch ?? "x64"))
    .replace(
      "process.report?.getReport().header.glibcVersionRuntime",
      options.glibc === false ? "undefined" : '"fixture-glibc"',
    )
    .replaceAll(wrapperAnchor, wrapperHash)
    .replaceAll(nativeAnchor, nativeHash);
  const scriptPath = path.join(root, "seed.mjs");
  fs.writeFileSync(scriptPath, script);
  const spec = `pnpm@12.4.0+sha512.${wrapperHash}`;
  return {
    root,
    image,
    registry,
    runner,
    store,
    calls,
    spec,
    run(extraEnv: NodeJS.ProcessEnv = {}, selected = spec) {
      return spawnSync(process.execPath, [scriptPath, selected], {
        encoding: "utf8",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RUNNER_TEMP: runner,
          CURL_CALLS: calls,
          FIXTURE_REGISTRY: registry,
          PNPM_CONFIG_STORE_DIR: store,
          ...extraEnv,
        },
      });
    },
  };
}
