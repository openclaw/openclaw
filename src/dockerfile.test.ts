import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_ROOT_DIR } from "../test/helpers/bundled-plugin-paths.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const packageJsonPath = join(repoRoot, "package.json");

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

describe("Dockerfile", () => {
  it("uses full bookworm for build stages and slim bookworm for runtime", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_TRIXIE_IMAGE="node:24-trixie@sha256:e4ceb04a1f1dd4823a1ab6ef8d2182c09d6299b507c70f20bd0eb9921a78354d"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_TRIXIE_SLIM_IMAGE="node:24-trixie-slim@sha256:9707cd4542f400df5078df04f9652a272429112f15202d22b5b8bdd148df494f"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_TRIXIE_IMAGE} AS ext-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_TRIXIE_IMAGE} AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_TRIXIE_SLIM_IMAGE} AS base-runtime");
    expect(dockerfile).toContain("FROM base-runtime");
    expect(dockerfile).toContain("current multi-arch manifest list entries");
    expect(dockerfile).not.toContain("current amd64 entry");
    expect(dockerfile).not.toContain("OPENCLAW_VARIANT");
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
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("Verifying critical native addons");
    expect(dockerfile).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(dockerfile).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("prunes runtime dependencies after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).toContain("  - ui\\n");
    expect(dockerfile).toContain("CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod");
    expect(dockerfile).toContain("prune must not rediscover unrelated workspaces");
    expect(dockerfile).not.toContain(
      `npm install --prefix "${BUNDLED_PLUGIN_ROOT_DIR}/$ext" --omit=dev --silent`,
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules",
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
    );
  });

  it("keeps package manager patch files in runtime images", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      pnpm?: { patchedDependencies?: Record<string, string> };
    };

    expect(Object.keys(packageJson.pnpm?.patchedDependencies ?? {})).not.toHaveLength(0);
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/patches ./patches",
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

  it("keeps runtime pnpm available", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV COREPACK_HOME=/usr/local/share/corepack");
    expect(dockerfile).toContain(
      'corepack prepare "$(node -p "require(\'./package.json\').packageManager")" --activate',
    );
  });

  it("base image ARG digest pairs are internally consistent", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    const imageDigest = dockerfile.match(
      /ARG OPENCLAW_NODE_TRIXIE_IMAGE="[^@]+@(sha256:[a-f0-9]{64})"/,
    )?.[1];
    const standaloneDigest = dockerfile.match(
      /ARG OPENCLAW_NODE_TRIXIE_DIGEST="(sha256:[a-f0-9]{64})"/,
    )?.[1];
    const slimImageDigest = dockerfile.match(
      /ARG OPENCLAW_NODE_TRIXIE_SLIM_IMAGE="[^@]+@(sha256:[a-f0-9]{64})"/,
    )?.[1];
    const slimStandaloneDigest = dockerfile.match(
      /ARG OPENCLAW_NODE_TRIXIE_SLIM_DIGEST="(sha256:[a-f0-9]{64})"/,
    )?.[1];

    expect(imageDigest).toBeDefined();
    expect(imageDigest).toBe(standaloneDigest);
    expect(slimImageDigest).toBeDefined();
    expect(slimImageDigest).toBe(slimStandaloneDigest);
  });

  it("smoke and e2e Dockerfiles use the same trixie-slim digest as the main Dockerfile", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const slimDigest = dockerfile.match(
      /ARG OPENCLAW_NODE_TRIXIE_SLIM_IMAGE="[^@]+@(sha256:[a-f0-9]{64})"/,
    )?.[1];
    expect(slimDigest).toBeDefined();

    const smokeFiles = [
      join(repoRoot, "scripts/docker/cleanup-smoke/Dockerfile"),
      join(repoRoot, "scripts/docker/install-sh-e2e/Dockerfile"),
      join(repoRoot, "scripts/docker/install-sh-smoke/Dockerfile"),
    ];
    for (const file of smokeFiles) {
      const content = await readFile(file, "utf8");
      expect(content, `${file} digest mismatch`).toContain(`node:24-trixie-slim@${slimDigest}`);
    }
  });
});
