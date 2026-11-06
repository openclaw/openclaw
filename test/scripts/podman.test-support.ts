import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const podmanEntrypoints = {
  seed: "scripts/podman/setup.sh",
  sync: "scripts/run-openclaw-podman.sh",
} as const;

export function podmanFixture(root: string, tools: string[] = []) {
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const config = path.join(home, ".openclaw");
  [bin, home].forEach((dir) => fs.mkdirSync(dir));
  for (const relative of [
    ...Object.values(podmanEntrypoints),
    "scripts/podman/common.sh",
    "scripts/lib/host-timeout.sh",
    "scripts/lib/build-metadata.sh",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  for (const name of [
    ..."awk cat chmod dirname install mkdir mktemp mv rm tr".split(" "),
    ...tools,
  ]) {
    const executable = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find(fs.existsSync);
    if (!executable) {
      throw new Error(`Missing shell fixture tool: ${name}`);
    }
    fs.symlinkSync(executable, path.join(bin, name));
  }
  const command = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Synthetic rootless identity; token and config operations still run the real scripts.
  command("id", 'case "$1" in -un) printf "fixture\\n";; *) printf "1000\\n";; esac');
  command("stat", 'case "$2" in %u) echo 1000;; %Lp|%a) echo 700;; *) exit 97;; esac');
  command("uname", "echo Linux");
  const run = (entrypoint: string, env: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [path.join(root, entrypoint)], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: bin,
        OPENCLAW_REPO_PATH: root,
        OPENCLAW_CONFIG_DIR: config,
        OPENCLAW_IMAGE: "fixture:local",
        OPENCLAW_BUILD_TIMESTAMP: "2026-09-28T12:00:00Z",
        ...env,
      },
    });
  return { config, command, run };
}
