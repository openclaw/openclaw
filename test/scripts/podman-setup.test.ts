// Exercise deployment-owned launch arguments without starting a container.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Podman browser origins",
  () => {
    function fixture(allowedOrigins?: string[]) {
      const home = tempDirs.make("openclaw-podman-origins-");
      const bin = join(home, "bin");
      const config = join(home, "config");
      mkdirSync(bin, { mode: 0o700 });
      mkdirSync(config, { mode: 0o700 });
      const log = join(home, "podman-args");
      for (const [name, body] of Object.entries({
        podman: `
case "$1" in
  create) touch "$PODMAN_STUB_ARGS-volume"; printf '%s' "\${@:$#}" > "$PODMAN_STUB_ARGS-probe.cjs"; printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';;
  inspect) printf '%s\\n' 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';;
  start) (cd "$HOME" && node "$PODMAN_STUB_ARGS-probe.cjs");;
  rm) printf "%s\\n" "$@" > "$PODMAN_STUB_ARGS"; if [[ " $* " == *" -v "* ]]; then rm -f "$PODMAN_STUB_ARGS-volume"; fi;;
  *) printf "%s\\n" "$@" > "$PODMAN_STUB_ARGS";;
esac`,
        openclaw: 'printf "lan\\n"',
        systemctl: "exit 0",
        uname: 'printf "Linux\\n"',
      })) {
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      }
      mkdirSync(join(home, "dist"));
      writeFileSync(join(home, "dist", "index.js"), 'console.log("--published-port <port>");');
      const file = join(config, "openclaw.json");
      writeFileSync(
        file,
        JSON.stringify({
          gateway: { publicOrigin: "https://old.example.com", controlUi: { allowedOrigins } },
        }),
        { mode: 0o600 },
      );
      writeFileSync(join(config, ".env"), "OPENCLAW_GATEWAY_TOKEN=fixture-token\n", {
        mode: 0o600,
      });
      function run(script: string, args: string[], port = "19123", expectedStatus = 0) {
        const result = spawnSync("/bin/bash", [join(repoRoot, script), ...args], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: home,
            OPENCLAW_REPO_PATH: repoRoot,
            OPENCLAW_CONFIG_DIR: config,
            OPENCLAW_WORKSPACE_DIR: join(home, "workspace"),
            OPENCLAW_PODMAN_IMAGE: "fixture:test",
            OPENCLAW_PODMAN_GATEWAY_HOST_PORT: port,
            PODMAN_STUB_ARGS: log,
          },
        });
        expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
        return result;
      }
      return { home, file, log, run };
    }

    it.each([
      { allowedOrigins: undefined },
      { allowedOrigins: [] },
      { allowedOrigins: ["https://admin.example.com", "http://localhost:18888"] },
    ])(
      "preserves operator origins through setup and changed-port launch (%j)",
      ({ allowedOrigins }) => {
        const sandbox = fixture(allowedOrigins);
        sandbox.run("scripts/podman/setup.sh", ["--container"]);
        expect(existsSync(`${sandbox.log}-volume`)).toBe(false);
        const config = JSON.parse(readFileSync(sandbox.file, "utf8"));
        expect(config.gateway).toEqual({
          mode: "local",
          publicOrigin: "https://old.example.com",
          controlUi: allowedOrigins === undefined ? {} : { allowedOrigins },
        });
        sandbox.run("scripts/run-openclaw-podman.sh", ["launch"]);
        let args = readFileSync(sandbox.log, "utf8").split("\n");
        expect(args[args.indexOf("--published-port") + 1]).toBe("19123");
        expect(args).toContain("127.0.0.1:19123:18789");
        config.gateway.publicOrigin = "https://new.example.com";
        const updated = JSON.stringify(config);
        writeFileSync(sandbox.file, updated);
        sandbox.run("scripts/run-openclaw-podman.sh", ["launch"], "20234");
        args = readFileSync(sandbox.log, "utf8").split("\n");
        expect(args[args.indexOf("--published-port") + 1]).toBe("20234");
        expect(args).toContain("127.0.0.1:20234:18789");
        expect(readFileSync(sandbox.file, "utf8")).toBe(updated);
        sandbox.run("scripts/run-openclaw-podman.sh", ["launch", "setup"]);
        expect(readFileSync(sandbox.log, "utf8")).not.toContain("--published-port");
      },
    );

    it.each(["scripts/podman/setup.sh", "scripts/run-openclaw-podman.sh"])(
      "rejects an older selected image without replacing the service or saved config (%s)",
      (script) => {
        const sandbox = fixture();
        writeFileSync(join(sandbox.home, "dist", "index.js"), 'console.log("--port <port>");');
        const before = readFileSync(sandbox.file, "utf8");
        const envPath = join(sandbox.home, "config", ".env");
        const envBefore = readFileSync(envPath, "utf8");
        const result = sandbox.run(
          script,
          script.includes("setup.sh") ? ["--quadlet"] : ["launch"],
          "19123",
          1,
        );
        expect(result.stderr).toContain("Select a compatible image or build this checkout");
        expect(existsSync(`${sandbox.log}-volume`)).toBe(false);
        expect(readFileSync(sandbox.file, "utf8")).toBe(before);
        expect(readFileSync(envPath, "utf8")).toBe(envBefore);
        expect(readFileSync(sandbox.log, "utf8")).not.toContain("--replace");
      },
    );

    it("retains the selected Quadlet image name for pull-and-restart upgrades", () => {
      const sandbox = fixture();
      sandbox.run("scripts/podman/setup.sh", ["--quadlet"]);
      const quadlet = readFileSync(
        join(sandbox.home, ".config/containers/systemd/openclaw.container"),
        "utf8",
      );
      expect(quadlet).toContain("Image=fixture:test");
      expect(quadlet).toContain("PublishPort=127.0.0.1:18789:18789");
      expect(quadlet).toContain("--published-port 18789");
      expect(JSON.parse(readFileSync(sandbox.file, "utf8")).gateway.controlUi).toEqual({});
    });
  },
);
