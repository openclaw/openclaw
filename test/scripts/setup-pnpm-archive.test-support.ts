import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { create } from "tar";
import type { CommandFixture } from "../helpers/command-fixture.js";

const owner = ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs";
const wrapperAnchor =
  "9c56477e360068d6e9dca6a92efb4e46b3dc5a52fcebf3d84d78b9736c0ded589a561621a52f68219a7a39facc63cdc079c3226ef9c9d5f02b79f74e69a807b6";
const nativeAnchor =
  "8065bb349166af7dc827a299bbed70f74281b45c4c55fffe0141bc68a269cb8bfa7519d4779bfce0f707d9e8d4bb1a7f7e6df3334218ea1f4bc1c60fbbd77176";

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
    fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ version: "12.7.0" }));
    fs.writeFileSync(path.join(stage, "pnpm"), native ? "native-fixture\n" : "wrapper-fixture\n");
    const dest = path.join(registry, name);
    create({ cwd: root, file: dest, gzip: true, sync: true }, [path.basename(stage)]);
    return createHash("sha512").update(fs.readFileSync(dest)).digest("hex");
  }
  const wrapperHash = archive("pnpm-12.7.0.tgz", false);
  const nativeHash = archive("exe.linux-x64-12.7.0.tgz", true);
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
  https://registry.npmjs.org/pnpm/-/pnpm-12.7.0.tgz) name=pnpm-12.7.0.tgz ;;
  https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.7.0.tgz) name=exe.linux-x64-12.7.0.tgz ;;
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
  const spec = `pnpm@12.7.0+sha512.${wrapperHash}`;
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
