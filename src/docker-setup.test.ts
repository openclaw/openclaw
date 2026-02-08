import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function writeDockerStub(binDir: string, logPath: string) {
  // Docker stub that logs commands with args separated by newlines for easier parsing
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  # Log each arg on its own line for precise verification
  echo "=== compose call ===" >>"$log"
  for arg in "$@"; do
    echo "arg: $arg" >>"$log"
  done
  echo "=== end ===" >>"$log"
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

/**
 * Generates a wrapper script from the real template with the given settings.
 * This avoids duplicating wrapper code in tests.
 */
async function generateWrapperFromTemplate(
  rootDir: string,
  useDockerDefault: 0 | 1,
): Promise<string> {
  const template = await readFile(
    join(repoRoot, "scripts/openclaw-docker-wrapper.template.sh"),
    "utf8",
  );
  const wrapper = template
    .replace(/__PROJECT_DIR__/g, rootDir)
    .replace(/__USE_DOCKER_DEFAULT__/g, String(useDockerDefault));
  const wrapperPath = join(rootDir, "wrapper.sh");
  await writeFile(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

describe("docker-setup.sh", () => {
  it("handles unset optional env vars under strict mode", async () => {
    const assocCheck = spawnSync("bash", ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status !== 0) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
    const scriptPath = join(rootDir, "docker-setup.sh");
    const dockerfilePath = join(rootDir, "Dockerfile");
    const composePath = join(rootDir, "docker-compose.yml");
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeFile(dockerfilePath, "FROM scratch\n");
    await writeFile(
      composePath,
      "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
    );
    await writeDockerStub(binDir, logPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: logPath,
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_CONFIG_DIR: join(rootDir, "config"),
      OPENCLAW_WORKSPACE_DIR: join(rootDir, "openclaw"),
    };
    delete env.OPENCLAW_DOCKER_APT_PACKAGES;
    delete env.OPENCLAW_EXTRA_MOUNTS;
    delete env.OPENCLAW_HOME_VOLUME;

    const result = spawnSync("bash", [scriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=");
    expect(envFile).toContain("OPENCLAW_EXTRA_MOUNTS=");
    expect(envFile).toContain("OPENCLAW_HOME_VOLUME=");
  });

  it("plumbs OPENCLAW_DOCKER_APT_PACKAGES into .env and docker build args", async () => {
    const assocCheck = spawnSync("bash", ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status !== 0) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
    const scriptPath = join(rootDir, "docker-setup.sh");
    const dockerfilePath = join(rootDir, "Dockerfile");
    const composePath = join(rootDir, "docker-compose.yml");
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeFile(dockerfilePath, "FROM scratch\n");
    await writeFile(
      composePath,
      "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
    );
    await writeDockerStub(binDir, logPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: logPath,
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg build-essential",
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_CONFIG_DIR: join(rootDir, "config"),
      OPENCLAW_WORKSPACE_DIR: join(rootDir, "openclaw"),
      OPENCLAW_EXTRA_MOUNTS: "",
      OPENCLAW_HOME_VOLUME: "",
    };

    const result = spawnSync("bash", [scriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const envFile = await readFile(join(rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg build-essential");
  });

  it("keeps docker-compose gateway command in sync", async () => {
    const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("gateway-daemon");
    expect(compose).toContain('"gateway"');
  });

  it("generates wrapper file with correct substitutions", async () => {
    const assocCheck = spawnSync("bash", ["-c", "declare -A _t=()"], {
      encoding: "utf8",
    });
    if (assocCheck.status !== 0) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-setup-"));
    const scriptPath = join(rootDir, "docker-setup.sh");
    const dockerfilePath = join(rootDir, "Dockerfile");
    const composePath = join(rootDir, "docker-compose.yml");
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");
    const configDir = join(rootDir, "config");
    const scriptsDir = join(rootDir, "scripts");

    const script = await readFile(join(repoRoot, "docker-setup.sh"), "utf8");
    const wrapperTemplate = await readFile(
      join(repoRoot, "scripts/openclaw-docker-wrapper.template.sh"),
      "utf8",
    );

    await writeFile(scriptPath, script, { mode: 0o755 });
    await writeFile(dockerfilePath, "FROM scratch\n");
    await writeFile(
      composePath,
      "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
    );
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "openclaw-docker-wrapper.template.sh"), wrapperTemplate);
    await writeDockerStub(binDir, logPath);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: logPath,
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: join(rootDir, "openclaw"),
    };

    const result = spawnSync("bash", [scriptPath], {
      cwd: rootDir,
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const wrapperPath = join(configDir, "openclaw-docker.sh");
    const wrapper = await readFile(wrapperPath, "utf8");

    // Verify substitutions were made
    expect(wrapper).toContain(`OPENCLAW_DOCKER_PROJECT_DIR="${rootDir}"`);
    expect(wrapper).not.toContain("__PROJECT_DIR__");
    expect(wrapper).not.toContain("__USE_DOCKER_DEFAULT__");
  });

  it("wrapper defaults to Docker when native CLI not found", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-wrapper-"));
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    await writeDockerStub(binDir, logPath);
    await writeFile(join(rootDir, "docker-compose.yml"), "services: {}\n");

    // Generate wrapper from real template (default to Docker)
    const wrapperPath = await generateWrapperFromTemplate(rootDir, 1);

    // Test: default behavior uses Docker when native CLI not in PATH
    spawnSync("bash", ["-c", `source "${wrapperPath}" && openclaw version`], {
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        DOCKER_STUB_LOG: logPath,
      },
      encoding: "utf8",
    });

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("arg: compose");
    expect(log).toContain("arg: openclaw-cli");
  });

  it("wrapper --docker flag forces Docker usage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-wrapper-"));
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    await writeDockerStub(binDir, logPath);
    await writeFile(join(rootDir, "docker-compose.yml"), "services: {}\n");

    // Generate wrapper from real template (default to native)
    const wrapperPath = await generateWrapperFromTemplate(rootDir, 0);

    // Test: --docker flag forces Docker even when default is native
    spawnSync("bash", ["-c", `source "${wrapperPath}" && openclaw --docker version`], {
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        DOCKER_STUB_LOG: logPath,
      },
      encoding: "utf8",
    });

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("arg: compose");
    expect(log).toContain("arg: openclaw-cli");
  });

  it("wrapper --no-docker flag forces native CLI when available", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-wrapper-"));
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");
    const nativeLogPath = join(rootDir, "native.log");

    await writeDockerStub(binDir, logPath);
    await writeFile(join(rootDir, "docker-compose.yml"), "services: {}\n");

    // Create a fake native openclaw binary that logs args
    const nativeStub = `#!/usr/bin/env bash
echo "=== native call ===" >> "${nativeLogPath}"
for arg in "$@"; do
  echo "arg: $arg" >> "${nativeLogPath}"
done
`;
    await writeFile(join(binDir, "openclaw"), nativeStub, { mode: 0o755 });
    await writeFile(nativeLogPath, "");

    // Generate wrapper from real template (default to Docker)
    const wrapperPath = await generateWrapperFromTemplate(rootDir, 1);

    // Test: --no-docker flag uses native CLI
    spawnSync("bash", ["-c", `source "${wrapperPath}" && openclaw --no-docker version`], {
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        DOCKER_STUB_LOG: logPath,
      },
      encoding: "utf8",
    });

    const nativeLog = await readFile(nativeLogPath, "utf8");
    const dockerLog = await readFile(logPath, "utf8");

    expect(nativeLog).toContain("=== native call ===");
    expect(nativeLog).toContain("arg: version");
    expect(dockerLog).toBe(""); // Docker should not have been called
  });

  it("wrapper --no-docker errors when native CLI not available", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-wrapper-"));
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    await writeDockerStub(binDir, logPath);
    await writeFile(join(rootDir, "docker-compose.yml"), "services: {}\n");

    // Generate wrapper from real template (default to Docker)
    // Note: no native openclaw binary created in binDir
    const wrapperPath = await generateWrapperFromTemplate(rootDir, 1);

    // Test: --no-docker should error when native CLI not found
    // Use isolated PATH with only binDir (no system openclaw)
    const result = spawnSync(
      "bash",
      ["-c", `source "${wrapperPath}" && openclaw --no-docker version`],
      {
        cwd: rootDir,
        env: {
          // Minimal PATH: only our bin dir + essential system paths (no user bins)
          PATH: `${binDir}:/usr/bin:/bin`,
          DOCKER_STUB_LOG: logPath,
          HOME: rootDir,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0); // Non-zero exit code
    // Error message could be in stderr or stdout depending on shell behavior
    const output = result.stderr + result.stdout;
    expect(output).toContain("--no-docker specified but native openclaw CLI not found");

    const dockerLog = await readFile(logPath, "utf8");
    expect(dockerLog).toBe(""); // Docker should not have been called
  });

  it("wrapper preserves arguments with spaces and special chars", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "openclaw-wrapper-"));
    const binDir = join(rootDir, "bin");
    const logPath = join(rootDir, "docker-stub.log");

    await writeDockerStub(binDir, logPath);
    await writeFile(join(rootDir, "docker-compose.yml"), "services: {}\n");

    // Generate wrapper from real template
    const wrapperPath = await generateWrapperFromTemplate(rootDir, 1);

    // Test: arguments with spaces are preserved correctly
    spawnSync(
      "bash",
      ["-c", `source "${wrapperPath}" && openclaw send "hello world" --to "user name"`],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          DOCKER_STUB_LOG: logPath,
        },
        encoding: "utf8",
      },
    );

    const log = await readFile(logPath, "utf8");
    // Verify each argument was passed separately (not concatenated)
    expect(log).toContain("arg: openclaw-cli");
    expect(log).toContain("arg: send");
    expect(log).toContain("arg: hello world"); // Space preserved within arg
    expect(log).toContain("arg: --to");
    expect(log).toContain("arg: user name"); // Space preserved within arg
  });
});
