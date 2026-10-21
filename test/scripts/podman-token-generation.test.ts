import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
// Synthetic rootless fixture (including root CI); never used by a real Gateway.
const fixtureToken = "ab".repeat(32);
const tokenLine = `OPENCLAW_GATEWAY_TOKEN=${fixtureToken}\n`;
const entrypoints = ["scripts/podman/setup.sh", "scripts/run-openclaw-podman.sh"] as const;
const backends = ["openssl", "python3", "od"] as const;

function runFixture(entrypoint: string, backend: (typeof backends)[number], exit: number) {
  const root = createTempDir("openclaw-podman-token-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const config = path.join(home, ".openclaw");
  const calls = path.join(root, "podman-calls");
  [bin, home].forEach((dir) => fs.mkdirSync(dir));
  for (const relative of [
    ...entrypoints,
    "scripts/podman/common.sh",
    "scripts/lib/host-timeout.sh",
    "scripts/lib/build-metadata.sh",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  for (const name of "awk cat chmod dirname install mkdir mktemp mv rm tr".split(" ")) {
    const executable = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find(fs.existsSync);
    if (!executable) {
      throw new Error(`Missing shell fixture tool: ${name}`);
    }
    fs.symlinkSync(executable, path.join(bin, name));
  }
  const command = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  command("id", 'case "$1" in -un) printf "fixture\\n";; *) printf "1000\\n";; esac');
  command(
    "stat",
    'case "$2" in %u) printf "1000\\n";; %Lp|%a) printf "700\\n";; *) exit 97;; esac',
  );
  command("uname", 'printf "Linux\\n"');
  command("podman", 'printf "%s\\n" "$*" >> "$PODMAN_CALLS"');
  const emitted = backend === "od" ? `${" ab".repeat(32)}\n` : `${fixtureToken}\n`;
  // Python also normalizes config after success; that operation may decline.
  command(
    backend,
    `${backend === "python3" ? '[[ "$#" -eq 1 ]] || exit 0\n' : ""}if [[ "$GENERATOR_EXIT" -ne 0 ]]; then
  printf "fixture random source failed\\n" >&2
  exit "$GENERATOR_EXIT"
fi
printf '%s' '${emitted}'`,
  );
  const env = {
    HOME: home,
    PATH: bin,
    OPENCLAW_REPO_PATH: root,
    OPENCLAW_CONFIG_DIR: config,
    OPENCLAW_IMAGE: "fixture:local",
    OPENCLAW_BUILD_TIMESTAMP: "2026-09-28T12:00:00Z",
    GENERATOR_EXIT: String(exit),
    PODMAN_CALLS: calls,
  };
  const result = spawnSync("/bin/bash", [path.join(root, entrypoint)], { env, encoding: "utf8" });
  return { result, token: path.join(config, ".env"), calls };
}

for (const entrypoint of entrypoints) {
  it.each(backends)(`${entrypoint} persists a successful %s token`, (backend) => {
    const { result, token } = runFixture(entrypoint, backend, 0);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(token, "utf8")).toContain(tokenLine);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fixtureToken);
  });

  it.each(backends)(`${entrypoint} stops when %s token generation fails`, (backend) => {
    const { result, token, calls } = runFixture(entrypoint, backend, 7);
    expect(result.stderr).toContain("fixture random source failed");
    expect(result.status).toBe(7);
    expect(fs.existsSync(token)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain("Generated OPENCLAW_GATEWAY_TOKEN");
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").not.toMatch(/^run /m);
  });
}
