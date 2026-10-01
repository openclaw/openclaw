import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const entrypoints = {
  seed: "scripts/podman/setup.sh",
  sync: "scripts/run-openclaw-podman.sh",
} as const;

function runPodman(operation: keyof typeof entrypoints, input: string, python = true) {
  const root = tempDirs.make("openclaw-podman-origins-");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const config = path.join(home, ".openclaw");
  const configPath = path.join(config, "openclaw.json");
  const cliCalls = path.join(root, "cli-calls");
  fs.mkdirSync(bin);
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, input, { mode: 0o640 });
  fs.writeFileSync(path.join(config, ".env"), "OPENCLAW_GATEWAY_TOKEN=fixture-token\n", {
    mode: 0o600,
  });
  for (const relative of [
    ...Object.values(entrypoints),
    "scripts/podman/common.sh",
    "scripts/lib/host-timeout.sh",
    "scripts/lib/build-metadata.sh",
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
    ...(python ? ["python3"] : []),
  ]) {
    const executable = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find(fs.existsSync);
    if (!executable) {
      throw new Error(`Missing shell fixture tool: ${name}`);
    }
    fs.symlinkSync(executable, path.join(bin, name));
  }
  const command = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // Rootless identity is synthetic; config bytes and Python transformations are real.
  command("id", 'case "$1" in -un) printf "fixture\\n";; *) printf "1000\\n";; esac');
  command("stat", 'case "$2" in %u) echo 1000;; %Lp|%a) echo 700;; *) exit 97;; esac');
  command("uname", "echo Linux");
  command("podman", "exit 0");
  command(
    "openclaw",
    `printf '%s\\n' "$*" >> "$CLI_CALLS"
case "$*" in
  'config get gateway.bind') echo lan ;;
  'config get gateway.controlUi.allowedOrigins') echo '["https://fallback.example"]' ;;
esac`,
  );
  const result = spawnSync("/bin/bash", [path.join(root, entrypoints[operation])], {
    encoding: "utf8",
    env: {
      HOME: home,
      PATH: bin,
      OPENCLAW_REPO_PATH: root,
      OPENCLAW_CONFIG_DIR: config,
      OPENCLAW_IMAGE: "fixture:local",
      OPENCLAW_PODMAN_GATEWAY_HOST_PORT: "43123",
      OPENCLAW_BUILD_TIMESTAMP: "2026-09-28T12:00:00Z",
      CLI_CALLS: cliCalls,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readdirSync(config).filter((name) => name.startsWith(".config.tmp."))).toEqual([]);
  return {
    result,
    configPath,
    output: fs.readFileSync(configPath, "utf8"),
    mode: fs.statSync(configPath).mode & 0o777,
    calls: fs.existsSync(cliCalls) ? fs.readFileSync(cliCalls, "utf8") : "",
  };
}

describe.each(["seed", "sync"] as const)("Podman %s Control UI origins", (operation) => {
  it("preserves config bytes and the distinct localhost and duplicate policies", () => {
    const input = JSON.stringify({
      label: "keep",
      gateway: {
        publicOrigin: "https://public.example",
        controlUi: {
          allowedOrigins: [
            " http://localhost:9999 ",
            " https://remote.example ",
            "https://remote.example",
            "http://127.0.0.1:43123",
            " ",
            null,
            7,
          ],
          enabled: true,
        },
      },
      tail: [1],
    });
    const fixture = runPodman(operation, input);
    const expectedOrigins =
      operation === "seed"
        ? [
            "https://remote.example",
            "https://remote.example",
            "http://127.0.0.1:43123",
            "http://localhost:43123",
          ]
        : [
            "http://localhost:9999",
            "https://remote.example",
            "http://127.0.0.1:43123",
            "http://localhost:43123",
          ];
    expect(fixture.output).toBe(
      `${JSON.stringify(
        {
          label: "keep",
          gateway: {
            publicOrigin: "https://public.example",
            controlUi: { allowedOrigins: expectedOrigins, enabled: true },
            mode: "local",
          },
          tail: [1],
        },
        null,
        2,
      )}\n`,
    );
    expect(fixture.mode).toBe(0o600);
    expect(fixture.result.stderr).toBe("");
    expect(fixture.calls).not.toContain("config set");
  });

  it.each([
    ["inherits a public origin", "https://public.example", undefined, {}],
    [
      "ignores an empty public origin",
      " ",
      undefined,
      { allowedOrigins: ["http://127.0.0.1:43123", "http://localhost:43123"] },
    ],
    [
      "honors explicit empty origins",
      "https://public.example",
      [],
      { allowedOrigins: ["http://127.0.0.1:43123", "http://localhost:43123"] },
    ],
  ])("%s", (_label, publicOrigin, allowedOrigins, expectedControlUi) => {
    const fixture = runPodman(
      operation,
      JSON.stringify({
        gateway: { publicOrigin, controlUi: { allowedOrigins } },
      }),
    );
    expect(fixture.output).toBe(
      `${JSON.stringify(
        {
          gateway: { publicOrigin, controlUi: expectedControlUi, mode: "local" },
        },
        null,
        2,
      )}\n`,
    );
    expect(fixture.result.stderr).toBe("");
  });

  it.each([
    ["[]", "expected top-level object"],
    ['{"gateway":[]}', "expected gateway object"],
    ['{"gateway":{"controlUi":[]}}', "expected gateway.controlUi object"],
  ])("leaves invalid config %s unchanged and preserves CLI fallback", (input, error) => {
    const fixture = runPodman(operation, input);
    expect(fixture.output).toBe(input);
    expect(fixture.mode).toBe(0o640);
    expect(fixture.result.stderr).toBe(`${fixture.configPath}: ${error}\n`);
    expect(fixture.calls.includes("config set gateway.controlUi.allowedOrigins")).toBe(
      operation === "sync",
    );
  });

  it("preserves malformed-JSON diagnostics and the existing file", () => {
    const fixture = runPodman(operation, "{");
    expect(fixture.output).toBe("{");
    expect(fixture.mode).toBe(0o640);
    expect(fixture.result.stderr).toBe(
      `Warning: unable to ${operation} gateway.controlUi.allowedOrigins in ${fixture.configPath}: existing config is not strict JSON (Expecting property name enclosed in double quotes: line 1 column 2 (char 1)). Leaving file unchanged.\n`,
    );
    expect(fixture.calls.includes("config set gateway.controlUi.allowedOrigins")).toBe(
      operation === "sync",
    );
  });

  it("warns without changing config or invoking CLI fallback when Python is absent", () => {
    const fixture = runPodman(operation, "{}", false);
    expect(fixture.output).toBe("{}");
    expect(fixture.mode).toBe(0o640);
    expect(fixture.result.stderr).toBe(
      `Warning: python3 not found; unable to ${operation} gateway.controlUi.allowedOrigins in ${fixture.configPath}.\n`,
    );
    expect(fixture.calls).not.toContain("config set");
  });
});
