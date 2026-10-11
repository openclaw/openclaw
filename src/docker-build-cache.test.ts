// Tests Docker build cache configuration and dependency cache keys.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePaths = [
  "Dockerfile",
  "scripts/docker/sandbox/Dockerfile",
  "scripts/docker/sandbox/Dockerfile.browser",
  "scripts/docker/sandbox/Dockerfile.common",
  "scripts/docker/cleanup-smoke/Dockerfile",
  "scripts/docker/install-sh-smoke/Dockerfile",
  "scripts/docker/install-sh-e2e/Dockerfile",
  "scripts/docker/install-sh-nonroot/Dockerfile",
  "scripts/e2e/Dockerfile.qr-import",
] as const;
const aptCacheDockerfilePaths = dockerfilePaths.filter(
  (path) => path !== "scripts/e2e/Dockerfile.qr-import",
);
const sandboxDockerfilePaths = dockerfilePaths.filter((path) =>
  path.startsWith("scripts/docker/sandbox/"),
);
const shellContinuationDockerfilePaths = dockerfilePaths.filter(
  (path) => path !== "Dockerfile" && path !== "scripts/e2e/Dockerfile.qr-import",
);
const repoFileCache = new Map<string, Promise<string>>();

async function readRepoFile(path: string): Promise<string> {
  let cached = repoFileCache.get(path);
  if (!cached) {
    cached = readFile(resolve(repoRoot, path), "utf8");
    repoFileCache.set(path, cached);
  }
  return cached;
}

describe("docker build cache layout", () => {
  beforeAll(async () => {
    await Promise.all(dockerfilePaths.map((path) => readRepoFile(path)));
  });

  it("keeps both dependency installs independent from the full source copy", async () => {
    const dockerfile = await readRepoFile("Dockerfile");
    const installIndex = dockerfile.lastIndexOf("pnpm install --frozen-lockfile");
    const copyAllIndex = dockerfile.indexOf("COPY . .");
    const scriptsCopyIndex = dockerfile.indexOf("COPY scripts ./scripts");

    expect(installIndex).toBeGreaterThan(-1);
    expect(copyAllIndex).toBeGreaterThan(installIndex);
    if (scriptsCopyIndex !== -1) {
      expect(scriptsCopyIndex).toBeGreaterThan(installIndex);
    }
  });

  it("uses pnpm cache mounts in Dockerfiles that install repo dependencies", async () => {
    for (const path of [
      "Dockerfile",
      "scripts/e2e/Dockerfile.qr-import",
      "scripts/docker/cleanup-smoke/Dockerfile",
    ]) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should use a shared pnpm store cache under the active user's home`,
      ).toMatch(
        /--mount=type=cache,id=openclaw-pnpm-store,target=\/(?:root|home\/appuser)\/\.local\/share\/pnpm\/store,sharing=locked/,
      );
    }
  });

  it("uses apt cache mounts in Dockerfiles that install system packages", async () => {
    for (const path of aptCacheDockerfilePaths) {
      const dockerfile = await readRepoFile(path);
      expect(dockerfile, `${path} should cache apt package archives`).toContain(
        "target=/var/cache/apt,sharing=locked",
      );
      expect(dockerfile, `${path} should cache apt metadata`).toContain(
        "target=/var/lib/apt,sharing=locked",
      );
    }
  });

  it("does not leave empty shell continuation lines in sandbox-common", async () => {
    const dockerfile = await readRepoFile("scripts/docker/sandbox/Dockerfile.common");
    expect(dockerfile).not.toContain("apt-get install -y --no-install-recommends ${PACKAGES} \\");
    expect(dockerfile).toContain("ARG INSTALL_NODE=1");
    expect(dockerfile).toContain("ARG NODE_MAJOR=24");
    expect(
      dockerfile.match(/curl -fsSL --connect-timeout 10 --max-time 120 -o "\$installer"/gu),
    ).toHaveLength(3);
    expect(dockerfile.match(/installer="\$\(mktemp\)"/gu)).toHaveLength(3);
    expect(dockerfile.match(/bash "\$installer" \|\| exit 1/gu)).toHaveLength(2);
    expect(dockerfile.match(/rm -f "\$installer"/gu)).toHaveLength(3);
    expect(dockerfile).toContain(
      "apt-get -o Acquire::Retries=5 install -y --no-install-recommends nodejs || exit 1;",
    );
    expect(dockerfile).toContain('ln -sf "${BUN_INSTALL_DIR}/bin/bun"');
    expect(dockerfile).toMatch(
      /chmod 0644 "\$installer"; \\\n\s+su - linuxbrew -c "NONINTERACTIVE=1 CI=1 \/bin\/bash '\$installer'" \|\| exit 1/u,
    );
    expect(dockerfile).not.toMatch(/curl[^\n]+\|\s*(?:bash|sh)/u);
    expect(dockerfile).toContain("source=package.json,target=/tmp/openclaw-package.json");
    expect(dockerfile).toContain(
      'npm install -g "$pnpm_spec" "--allow-scripts=$pnpm_spec" && pnpm --version;',
    );
  });

  it("retries transient apt failures in sandbox images without skipping packages", async () => {
    for (const path of sandboxDockerfilePaths) {
      const dockerfile = await readRepoFile(path);
      const updates = dockerfile.match(/(?<!")apt-get[^\n;&|]*\supdate\b[^\n;&|]*/gu) ?? [];
      const installs = dockerfile.match(/(?<!")apt-get[^\n;&|]*\sinstall\b[^\n;&|]*/gu) ?? [];

      expect(updates.length, `${path} should run apt-get update`).toBeGreaterThan(0);
      expect(installs.length, `${path} should run apt-get install`).toBeGreaterThan(0);
      for (const update of updates) {
        expect(update, `${path} should retry and fail on index fetch errors`).toBe(
          "apt-get -o Acquire::Retries=5 update --error-on=any",
        );
      }
      for (const install of installs) {
        expect(install, `${path} should retry package downloads`).toMatch(
          /^apt-get -o Acquire::Retries=5 install -y --no-install-recommends\b/u,
        );
        expect(install, `${path} must not skip unavailable packages`).not.toMatch(
          /--fix-missing|--ignore-missing|\s-m\b/u,
        );
      }
      expect(dockerfile.match(/for attempt in 1 2 3; do/gu)).toHaveLength(updates.length);
      expect(dockerfile, `${path} should fail after the last update attempt`).toContain(
        'if [ "${attempt}" -eq 3 ]; then exit 1; fi;',
      );
      expect(dockerfile, `${path} must not skip unavailable packages`).not.toContain(
        "--fix-missing",
      );
    }
  });

  it("does not leave blank lines after shell continuation markers", async () => {
    for (const path of shellContinuationDockerfilePaths) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should not have blank lines after a trailing backslash`,
      ).not.toMatch(/\\\n\s*\n/);
    }
  });

  it("copies manifests before install in the qr-import image", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile.qr-import");
    const installIndex = dockerfile.indexOf(
      "pnpm --filter 'openclaw...' install --frozen-lockfile",
    );
    const manifestCopyIndex = dockerfile.search(
      /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/m,
    );
    const uiCopyIndex = dockerfile.search(
      /^COPY(?:\s+--chown=\S+)?\s+ui\/package\.json \.\/ui\/package\.json$/m,
    );

    expect(manifestCopyIndex).toBeGreaterThan(-1);
    expect(manifestCopyIndex).toBeLessThan(installIndex);
    expect(uiCopyIndex).toBeGreaterThan(-1);
    expect(uiCopyIndex).toBeLessThan(installIndex);
    const workspaceCopyIndex = dockerfile.indexOf(
      "COPY --parents --chown=appuser:appuser packages/*/package.json extensions/*/package.json examples/*/package.json ./",
    );
    expect(workspaceCopyIndex).toBeGreaterThan(-1);
    expect(workspaceCopyIndex).toBeLessThan(installIndex);
    expect(
      dockerfile.search(
        /^COPY(?:\s+--chown=\S+)?\s+extensions\/memory-core\/package\.json \.\/extensions\/memory-core\/package\.json$/m,
      ),
    ).toBe(-1);
    expect(dockerfile.search(/^COPY(?:\s+--chown=\S+)?\s+\.\s+\.$/m)).toBeGreaterThan(installIndex);
  });

  it("copies .npmrc before install in the cleanup smoke image", async () => {
    const dockerfile = await readRepoFile("scripts/docker/cleanup-smoke/Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const manifestCopyIndex = dockerfile.search(
      /^COPY(?:\s+--chown=\S+)?\s+package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.npmrc \.\/$/m,
    );

    expect(manifestCopyIndex).toBeGreaterThan(-1);
    expect(manifestCopyIndex).toBeLessThan(installIndex);
    expect(dockerfile.search(/^COPY(?:\s+--chown=\S+)?\s+\.\s+\.$/m)).toBeGreaterThan(installIndex);
  });
});
