import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { create } from "tar";
import type { CommandFixture } from "../helpers/command-fixture.js";

const owner = ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs";
const currentWrapperAnchor =
  "b7f98934c0b1f29a65f5da52f2d7f994e7faad573ffdddea1497fb4dcb5aec051590ee7c7d95a38172b4bfae103a5b83edf2ee866e11731c2cafa96063610ac5";
const currentNativeAnchor =
  "ddb27792f3227fb7257f178fa01678d051af539e0684bc10f9e6f18f11ae2981f0ac3c9231fca0815191d20618729aeae883c6cba0ab4cf8aa80fe533932c2e7";

export function createPnpmArchiveFixture(
  command: CommandFixture,
  options: {
    platform?: string;
    arch?: string;
    glibc?: boolean;
    registryUrl?: string;
    version?: "12.3.4" | "12.12.1";
    image?: boolean;
  } = {},
) {
  const version = options.version ?? "12.12.1";
  const root = command.createTempDir("pnpm-verified-download-");
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
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(
      path.join(stage, "pnpm"),
      options.image ? name : native ? "native-fixture\n" : "wrapper-fixture\n",
    );
    if (options.image) {
      fs.mkdirSync(path.join(stage, "bin"));
      fs.writeFileSync(
        path.join(stage, "bin/pnpm.mjs"),
        `console.log(${JSON.stringify(version)});`,
      );
    }
    const dest = path.join(registry, name);
    create({ cwd: root, file: dest, gzip: true, sync: true }, [path.basename(stage)]);
    if (options.image) {
      fs.copyFileSync(dest, path.join(image, name));
    }
    return createHash("sha512").update(fs.readFileSync(dest)).digest("hex");
  }
  const wrapperHash = archive(`pnpm-${version}.tgz`, false);
  const nativeHash = archive(`exe.linux-x64-${version}.tgz`, true);
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
  https://registry.npmjs.org/pnpm/-/pnpm-12.12.1.tgz) name=pnpm-12.12.1.tgz ;;
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.12.1.tgz) name=exe.linux-x64-12.12.1.tgz ;;
  *) exit 91 ;;
esac
cp "$FIXTURE_REGISTRY/$name" "$out"
`,
    { mode: 0o755 },
  );
  if (options.registryUrl) {
    fs.unlinkSync(curl);
  }
  const script = fs
    .readFileSync(owner, "utf8")
    .replace(
      'const registry = "https://registry.npmjs.org";',
      `const registry = ${JSON.stringify(options.registryUrl ?? "https://registry.npmjs.org")};`,
    )
    .replaceAll("/opt/crabbox/toolchain-archives", image)
    .replaceAll("process.platform", JSON.stringify(options.platform ?? "linux"))
    .replaceAll("process.arch", JSON.stringify(options.arch ?? "x64"))
    .replace(
      "process.report?.getReport().header.glibcVersionRuntime",
      options.glibc === false ? "undefined" : '"fixture-glibc"',
    )
    .replaceAll(
      version === "12.12.1"
        ? currentWrapperAnchor
        : "961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457",
      wrapperHash,
    )
    .replaceAll(
      version === "12.12.1"
        ? currentNativeAnchor
        : "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
      nativeHash,
    );
  const scriptPath = path.join(root, "seed.mjs");
  fs.writeFileSync(scriptPath, script);
  const spec = `pnpm@${version}+sha512.${wrapperHash}`;
  return {
    root,
    image,
    registry,
    runner,
    store,
    calls,
    spec,
    async run(extraEnv: NodeJS.ProcessEnv = {}, selected = spec) {
      const result = await command.run(process.execPath, [scriptPath, selected], {
        encoding: "utf8",
        env: {
          ...(options.image
            ? {
                ...process.env,
                COREPACK_ENABLE_NETWORK: "0",
                COREPACK_HOME: path.join(root, "old-corepack"),
              }
            : {}),
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          RUNNER_TEMP: runner,
          CURL_HOME: root,
          CURL_CALLS: calls,
          FIXTURE_REGISTRY: registry,
          PNPM_CONFIG_STORE_DIR: store,
          ...extraEnv,
        },
      });
      if (result.error) {
        throw new Error("Pinned pnpm archive fixture subprocess failed", { cause: result.error });
      }
      return result;
    },
  };
}
