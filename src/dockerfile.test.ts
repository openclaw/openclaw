import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const dockerComposePath = join(repoRoot, "docker-compose.yml");
const dockerSetupPath = join(repoRoot, "scripts/docker/setup.sh");
const packageJsonPath = join(repoRoot, "package.json");

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

const hostedAgentRuntimePackages = [
  "ca-certificates",
  "curl",
  "file",
  "gh",
  "git",
  "hostname",
  "jq",
  "lsof",
  "openssh-client",
  "openssl",
  "procps",
  "python-is-python3",
  "python3",
  "python3-bs4",
  "python3-pip",
  "python3-requests",
  "python3-venv",
  "ripgrep",
  "sqlite3",
  "unzip",
  "wget",
  "zip",
];

function runtimeInstallSection(dockerfile: string): string {
  const runtimeIndex = dockerfile.indexOf(
    "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
  );
  const userCreateIndex = dockerfile.indexOf("RUN groupadd --gid 1001 openclaw");
  expect(runtimeIndex).toBeGreaterThan(-1);
  expect(userCreateIndex).toBeGreaterThan(runtimeIndex);
  return dockerfile.slice(runtimeIndex, userCreateIndex);
}

describe("Dockerfile", () => {
  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS ext-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime");
    expect(dockerfile).toContain("FROM base-runtime");
    expect(dockerfile).toContain("current multi-arch manifest list entries");
    expect(dockerfile).not.toContain("current amd64 entry");
    expect(dockerfile).not.toContain("OPENCLAW_VARIANT");
  });

  it("installs CA certificates in the slim runtime stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const collapsed = collapseDockerContinuations(dockerfile);
    const runtimeIndex = collapsed.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const section = runtimeInstallSection(collapsed);
    const caInstallIndex = section.indexOf("ca-certificates");

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(caInstallIndex).toBeGreaterThan(-1);
    expect(collapsed).toMatch(/apt-get install -y --no-install-recommends\s+ca-certificates/);
    expect(collapsed).toContain("update-ca-certificates");
  });

  it("installs python3 in the slim runtime stage for workspace scripts", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const runtimeIndex = dockerfile.indexOf(
      "FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime",
    );
    const section = runtimeInstallSection(dockerfile);
    const pythonInstallIndex = section.indexOf("python3");

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(pythonInstallIndex).toBeGreaterThan(-1);
    expect(dockerfile).toContain("python-is-python3");
    expect(dockerfile).toContain("python3-pip");
    expect(dockerfile).toContain("python3-venv");
  });

  it("installs practical hosted-agent runtime tools in the slim runtime stage", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));

    for (const pkg of hostedAgentRuntimePackages) {
      expect(dockerfile).toContain(pkg);
    }
  });

  it("pre-creates writable package manager homes for the non-root runtime user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain("NPM_CONFIG_PREFIX=/home/openclaw/.local");
    expect(dockerfile).toContain("NPM_CONFIG_CACHE=/home/openclaw/.npm");
    expect(dockerfile).toContain("PIP_CACHE_DIR=/home/openclaw/.cache/pip");
    expect(dockerfile).toContain("install -d -m 0755 -o openclaw -g openclaw");
    expect(dockerfile).toContain("/home/openclaw/.npm");
    expect(dockerfile).toContain("install -d -m 0700 -o openclaw -g openclaw /home/openclaw/.ssh");
  });

  it("runs hosted containers as openclaw uid 1001 with root-home compatibility", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain("groupadd --gid 1001 openclaw");
    expect(dockerfile).toContain("useradd --uid 1001 --gid 1001");
    expect(dockerfile).toContain("/home/openclaw --create-home");
    expect(dockerfile).toContain("USER openclaw");
    expect(dockerfile).not.toContain("USER node");
    expect(dockerfile).toContain(
      "install -d -m 0700 -o openclaw -g openclaw /home/openclaw/.openclaw",
    );
    expect(dockerfile).toContain("grep -qx 'openclaw:openclaw 1001:1001 700'");
    expect(dockerfile).toContain("chmod 711 /root");
    expect(dockerfile).toContain("ln -s /home/openclaw/.openclaw /root/.openclaw");
  });

  it("keeps Docker Compose paths aligned with the openclaw uid-1001 home", async () => {
    const compose = await readFile(dockerComposePath, "utf8");

    expect(compose).toContain("HOME: /home/openclaw");
    expect(compose).toContain(":/home/openclaw/.openclaw");
    expect(compose).toContain(":/home/openclaw/.openclaw/workspace");
    expect(compose).not.toContain("/home/node");
  });

  it("keeps Docker Compose gateway resource guardrails enabled by default", async () => {
    const compose = await readFile(dockerComposePath, "utf8");

    expect(compose).toContain("NVIDIA_VISIBLE_DEVICES: ${NVIDIA_VISIBLE_DEVICES:-none}");
    expect(compose).toContain("cap_drop:\n      - NET_RAW\n      - NET_ADMIN");
    expect(compose).toContain("security_opt:\n      - no-new-privileges:true");
    expect(compose).toContain("mem_limit: ${OPENCLAW_GATEWAY_MEMORY:-3g}");
    expect(compose).toContain("memswap_limit: ${OPENCLAW_GATEWAY_MEMORY_SWAP:-6g}");
    expect(compose).toContain('cpus: "${OPENCLAW_GATEWAY_CPUS:-1.5}"');
    expect(compose).toContain("pids_limit: ${OPENCLAW_GATEWAY_PIDS_LIMIT:-384}");
    expect(compose).toContain("max-size: ${OPENCLAW_GATEWAY_LOG_MAX_SIZE:-10m}");
    expect(compose).toContain('max-file: "${OPENCLAW_GATEWAY_LOG_MAX_FILE:-3}"');
  });

  it("keeps Docker setup chown repair aligned with the openclaw uid-1001 home", async () => {
    const setup = await readFile(dockerSetupPath, "utf8");

    expect(setup).toContain("user (uid 1001)");
    expect(setup).toContain("${home_volume}:/home/openclaw");
    expect(setup).toContain("${OPENCLAW_CONFIG_DIR}:/home/openclaw/.openclaw");
    expect(setup).toContain("find /home/openclaw/.openclaw -xdev -exec chown openclaw:openclaw");
    expect(setup).not.toContain("/home/node");
    expect(setup).not.toContain("node:node");
    expect(setup).not.toContain("uid 1000");
  });

  it("enables hosted runtime guards in the slim runtime image", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    expect(dockerfile).toContain("OPENCLAW_DISABLE_BONJOUR=1");
    expect(dockerfile).toContain("OPENCLAW_LENIENT_CHANNEL_CONFIG=1");
    expect(dockerfile).toContain("OPENCLAW_NO_AUTO_UPDATE=1");
    expect(dockerfile).toContain("OPENCLAW_NO_UPDATE_CHECK=1");
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG OPENCLAW_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/home/openclaw/.cache/ms-playwright");
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("Verifying critical native addons");
    expect(dockerfile).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(dockerfile).toContain(
      "node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js",
    );
    expect(dockerfile).toContain("matrix-sdk-crypto native addon missing after retries");
    expect(dockerfile).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("copies postinstall helper imports before pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const postinstallIndex = dockerfile.indexOf("COPY scripts/postinstall-bundled-plugins.mjs");
    const distImportHelperIndex = dockerfile.indexOf(
      "COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs",
    );

    expect(postinstallIndex).toBeGreaterThan(-1);
    expect(distImportHelperIndex).toBeGreaterThan(-1);
    expect(postinstallIndex).toBeLessThan(installIndex);
    expect(distImportHelperIndex).toBeLessThan(installIndex);
  });

  it("prunes runtime dependencies after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const normalizedExtensionLoop =
      "for ext in $(printf '%s\\n' \"$OPENCLAW_EXTENSIONS\" | tr ',' ' '); do \\";
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain(
      "Opt-in plugin dependencies at build time (space- or comma-separated directory names).",
    );
    expect(dockerfile).toContain(
      'Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .',
    );
    expect(dockerfile.split(normalizedExtensionLoop).length - 1).toBe(2);
    expect(dockerfile).toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).toContain("  - ui\\n");
    expect(dockerfile).toContain("CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod");
    expect(dockerfile).toContain(
      'OPENCLAW_EXTENSIONS="$OPENCLAW_EXTENSIONS" node scripts/prune-docker-plugin-dist.mjs',
    );
    expect(dockerfile).toContain("prune must not rediscover unrelated workspaces");
    expect(dockerfile).not.toContain(
      `npm install --prefix "${BUNDLED_PLUGIN_ROOT_DIR}/$ext" --omit=dev --silent`,
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=openclaw:openclaw /app/node_modules ./node_modules",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=openclaw:openclaw /app/patches ./patches",
    );
  });

  it("keeps package manager patch files in runtime images", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };

    expect(Object.keys(packageJson.pnpm?.patchedDependencies ?? {})).not.toHaveLength(0);
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=openclaw:openclaw /app/patches ./patches",
    );
  });

  it("does not override bundled plugin discovery in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain(`ARG OPENCLAW_BUNDLED_PLUGIN_DIR=${BUNDLED_PLUGIN_ROOT_DIR}`);
    expect(dockerfile).not.toMatch(/^\s*ENV\b[^\n]*\bOPENCLAW_BUNDLED_PLUGINS_DIR\b/m);
  });

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("Docker GPG fingerprint awk uses correct quoting for OPENCLAW_SANDBOX=1 build", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const anchor = dockerfile.indexOf(
      "curl -fsSL https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    expect(anchor).toBeGreaterThan(-1);
    const slice = dockerfile.slice(anchor);
    expect(slice).toContain("docker_gpg_pub_count=");
    expect(slice).toContain('$1 == "pub"');
    expect(slice).not.toContain('\\"pub\\"');
    const pubCountIdx = slice.indexOf("docker_gpg_pub_count=");
    const fpIdx = slice.indexOf("actual_fingerprint=");
    const dearmorIdx = slice.indexOf("gpg --dearmor");
    expect(pubCountIdx).toBeLessThan(fpIdx);
    expect(fpIdx).toBeLessThan(dearmorIdx);
    expect(slice).toContain('[ "$docker_gpg_pub_count" != "1" ]');
  });

  it("keeps runtime pnpm available", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV COREPACK_HOME=/usr/local/share/corepack");
    expect(dockerfile).toContain(
      'corepack prepare "$(node -p "require(\'./package.json\').packageManager")" --activate',
    );
  });

  it("pre-creates the OpenClaw home before switching to the openclaw user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const stateDirIndex = dockerfile.indexOf(
      "RUN install -d -m 0700 -o openclaw -g openclaw /home/openclaw/.openclaw && \\",
      runtimeStageIndex,
    );
    const userIndex = dockerfile.indexOf("USER openclaw", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(stateDirIndex).toBeLessThan(userIndex);
    expect(dockerfile).not.toContain("mkdir -p /home/openclaw/.openclaw");
    expect(dockerfile).toContain(
      "stat -c '%U:%G %u:%g %a' /home/openclaw/.openclaw | grep -qx 'openclaw:openclaw 1001:1001 700'",
    );
  });
});
