import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { create } from "tar";
import type { CommandFixture } from "../helpers/command-fixture.js";

const owner = ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs";
const wrapperAnchor =
  "a5941679663d952c5f0ecc38ba98af98b4dc01b95780354f6894f2f873973cef2f7e2989d7db3ee5393938ae21f62fe06bcdf685d475ddad829a62095d2b8b11";
const nativeAnchor =
  "dab8cfd476e948c792c9f6cfd827061b42f6fabfbd8072808d80996508ffdd2750072c2e809f5a6b9396c8fa7acb3d19e7177bb4a754b50261d3d4e764e521c0";

export function createPnpmArchiveFixture(
  command: CommandFixture,
  options: { platform?: string; arch?: string; glibc?: boolean; registryUrl?: string } = {},
) {
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
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "12.8.2" }));
    fs.writeFileSync(path.join(stage, "pnpm"), native ? "native-fixture\n" : "wrapper-fixture\n");
    const dest = path.join(registry, name);
    create({ cwd: root, file: dest, gzip: true, sync: true }, [path.basename(stage)]);
    return createHash("sha512").update(fs.readFileSync(dest)).digest("hex");
  }
  const wrapperHash = archive("pnpm-12.8.2.tgz", false);
  const nativeHash = archive("exe.linux-x64-12.8.2.tgz", true);
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
  https://registry.npmjs.org/pnpm/-/pnpm-12.8.2.tgz) name=pnpm-12.8.2.tgz ;;
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.8.2.tgz) name=exe.linux-x64-12.8.2.tgz ;;
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
    .replaceAll(wrapperAnchor, wrapperHash)
    .replaceAll(nativeAnchor, nativeHash);
  const scriptPath = path.join(root, "seed.mjs");
  fs.writeFileSync(scriptPath, script);
  const spec = `pnpm@12.8.2+sha512.${wrapperHash}`;
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
