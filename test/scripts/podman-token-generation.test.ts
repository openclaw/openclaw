import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
// Synthetic fixture bytes only; never used by a real Gateway.
const fixtureToken = "ab".repeat(32);
const entrypoints = ["scripts/podman/setup.sh", "scripts/run-openclaw-podman.sh"] as const;
const backends = ["openssl", "python3", "od"] as const;

function createFixture(backend: (typeof backends)[number], generatorExit: number) {
  const root = createTempDir("openclaw-podman-token-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const config = path.join(home, ".openclaw");
  const calls = path.join(root, "podman-calls");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  for (const relative of [
    ...entrypoints,
    "scripts/podman/common.sh",
    "scripts/lib/host-timeout.sh",
    "scripts/lib/build-metadata.sh",
    "scripts/lib/container-gateway-capability.sh",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  for (const name of [
    "awk",
    "cat",
    "chmod",
    "dirname",
    "install",
    "mkdir",
    "mktemp",
    "mv",
    "rm",
    "tr",
  ]) {
    const executable = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find(fs.existsSync);
    if (!executable) {
      throw new Error(`Missing shell fixture tool: ${name}`);
    }
    fs.symlinkSync(executable, path.join(bin, name));
  }
  const command = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Fixed rootless identity also works when CI itself runs as root. Files and
  // persistence remain real; no service, container, or host credentials are used.
  command("id", 'case "$1" in -un) printf "fixture\\n";; *) printf "1000\\n";; esac');
  command(
    "stat",
    'case "$2" in %u) printf "1000\\n";; %Lp|%a) printf "700\\n";; *) exit 97;; esac',
  );
  command("uname", 'printf "Linux\\n"');
  command(
    "podman",
    [
      'printf "%s\\n" "$*" >> "$PODMAN_CALLS"',
      'case "$1" in',
      `  create) printf '%s\\n' '${"a".repeat(64)}';;`,
      `  inspect) printf '%s\\n' 'sha256:${"b".repeat(64)}';;`,
      '  start) printf "%s" "published-port";;',
      "esac",
    ].join("\n"),
  );
  const emitted = backend === "od" ? `${" ab".repeat(32)}\n` : `${fixtureToken}\n`;
  command(
    backend,
    [
      // Python is also an optional config-normalization helper after success;
      // that separate operation may decline without preventing startup.
      ...(backend === "python3" ? ['[[ "$#" -eq 1 ]] || exit 0'] : []),
      'if [[ "$GENERATOR_EXIT" -ne 0 ]]; then',
      '  printf "fixture random source failed\\n" >&2',
      '  exit "$GENERATOR_EXIT"',
      "fi",
      `printf '%s' '${emitted}'`,
    ].join("\n"),
  );
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: bin,
    OPENCLAW_REPO_PATH: root,
    OPENCLAW_CONFIG_DIR: config,
    OPENCLAW_IMAGE: "fixture:local",
    OPENCLAW_BUILD_TIMESTAMP: "2026-09-28T12:00:00Z",
    GENERATOR_EXIT: String(generatorExit),
    PODMAN_CALLS: calls,
  };
  return { root, config, calls, env };
}

describe("Podman generated gateway tokens", () => {
  for (const entrypoint of entrypoints) {
    it.each(backends)(`${entrypoint} persists a successful %s token`, (backend) => {
      const fixture = createFixture(backend, 0);
      const result = spawnSync("/bin/bash", [path.join(fixture.root, entrypoint)], {
        env: fixture.env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(path.join(fixture.config, ".env"), "utf8")).toContain(
        `OPENCLAW_GATEWAY_TOKEN=${fixtureToken}\n`,
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(fixtureToken);
    });

    it.each(backends)(`${entrypoint} stops when %s token generation fails`, (backend) => {
      const fixture = createFixture(backend, 7);
      const result = spawnSync("/bin/bash", [path.join(fixture.root, entrypoint)], {
        env: fixture.env,
        encoding: "utf8",
      });
      expect(result.stderr).toContain("fixture random source failed");
      expect(result.status).toBe(7);
      expect(fs.existsSync(path.join(fixture.config, ".env"))).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain("Generated OPENCLAW_GATEWAY_TOKEN");
      const calls = fs.existsSync(fixture.calls) ? fs.readFileSync(fixture.calls, "utf8") : "";
      expect(calls).not.toMatch(/^run /m);
    });
  }
});
