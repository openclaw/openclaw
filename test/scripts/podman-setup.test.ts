// Exercise deployment-owned launch arguments without starting a container.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
        podman: 'printf "%s\\n" "$@" > "$PODMAN_STUB_ARGS"',
        openclaw: 'printf "lan\\n"',
        systemctl: "exit 0",
        uname: 'printf "Linux\\n"',
      })) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      }
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
      function run(script: string, args: string[], port = "19123") {
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
        expect(result.status, result.stderr || result.stdout).toBe(0);
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

    it("generates matching Quadlet port metadata without persisting an allowlist", () => {
      const sandbox = fixture();
      sandbox.run("scripts/podman/setup.sh", ["--quadlet"]);
      const quadlet = readFileSync(
        join(sandbox.home, ".config/containers/systemd/openclaw.container"),
        "utf8",
      );
      expect(quadlet).toContain("PublishPort=127.0.0.1:18789:18789");
      expect(quadlet).toContain("--published-port 18789");
      expect(JSON.parse(readFileSync(sandbox.file, "utf8")).gateway.controlUi).toEqual({});
    });
  },
);
