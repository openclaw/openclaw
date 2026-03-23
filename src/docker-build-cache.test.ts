import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("docker build cache layout", () => {
  it("keeps the root dependency layer independent from scripts changes", async () => {
    const dockerfile = await readRepoFile("Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const copyAllIndex = dockerfile.indexOf("COPY . .");
    const scriptsCopyIndex = dockerfile.indexOf("COPY scripts ./scripts");

    expect(installIndex).toBeGreaterThan(-1);
    expect(copyAllIndex).toBeGreaterThan(installIndex);
    expect(scriptsCopyIndex === -1 || scriptsCopyIndex > installIndex).toBe(true);
  });

  it("uses pnpm cache mounts in Dockerfiles that install repo dependencies", async () => {
    for (const path of [
      "Dockerfile",
      "scripts/e2e/Dockerfile",
      "scripts/e2e/Dockerfile.qr-import",
      "scripts/docker/cleanup-smoke/Dockerfile",
    ]) {
      const dockerfile = await readRepoFile(path);
      expect(dockerfile, `${path} should use a shared pnpm store cache`).toContain(
        "--mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked",
      );
    }
  });

  it("uses apt cache mounts in Dockerfiles that install system packages", async () => {
    for (const path of [
      "Dockerfile",
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/cleanup-smoke/Dockerfile",
      "scripts/docker/install-sh-smoke/Dockerfile",
      "scripts/docker/install-sh-e2e/Dockerfile",
      "scripts/docker/install-sh-nonroot/Dockerfile",
    ]) {
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
    const dockerfile = await readRepoFile("Dockerfile.sandbox-common");
    expect(dockerfile).not.toContain("apt-get install -y --no-install-recommends ${PACKAGES} \\");
    expect(dockerfile).toContain(
      'RUN if [ "${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi',
    );
  });

  it("does not leave blank lines after shell continuation markers", async () => {
    for (const path of [
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/cleanup-smoke/Dockerfile",
      "scripts/docker/install-sh-smoke/Dockerfile",
      "scripts/docker/install-sh-e2e/Dockerfile",
      "scripts/docker/install-sh-nonroot/Dockerfile",
    ]) {
      const dockerfile = await readRepoFile(path);
      expect(
        dockerfile,
        `${path} should not have blank lines after a trailing backslash`,
      ).not.toMatch(/\\\n\s*\n/);
    }
  });

  it("copies only install inputs before pnpm install in the e2e image", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

    expect(
      dockerfile.indexOf("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./"),
    ).toBeLessThan(installIndex);
    expect(dockerfile.indexOf("COPY ui/package.json ./ui/package.json")).toBeLessThan(installIndex);
    expect(
      dockerfile.indexOf(
        "COPY extensions/memory-core/package.json ./extensions/memory-core/package.json",
      ),
    ).toBeLessThan(installIndex);
    expect(
      dockerfile.indexOf(
        "COPY tsconfig.json tsconfig.plugin-sdk.dts.json tsdown.config.ts vitest.config.ts vitest.e2e.config.ts openclaw.mjs ./",
      ),
    ).toBeGreaterThan(installIndex);
    expect(dockerfile.indexOf("COPY src ./src")).toBeGreaterThan(installIndex);
    expect(dockerfile.indexOf("COPY test ./test")).toBeGreaterThan(installIndex);
    expect(dockerfile.indexOf("COPY scripts ./scripts")).toBeGreaterThan(installIndex);
    expect(dockerfile.indexOf("COPY ui ./ui")).toBeGreaterThan(installIndex);
  });

  it("copies manifests before install in the qr-import image", async () => {
    const dockerfile = await readRepoFile("scripts/e2e/Dockerfile.qr-import");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");

    expect(
      dockerfile.indexOf("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./"),
    ).toBeLessThan(installIndex);
    expect(dockerfile.indexOf("COPY ui/package.json ./ui/package.json")).toBeLessThan(installIndex);
    expect(dockerfile).toContain(
      "This image only exercises the root qrcode-terminal dependency path.",
    );
    expect(
      dockerfile.indexOf(
        "COPY extensions/memory-core/package.json ./extensions/memory-core/package.json",
      ),
    ).toBe(-1);
    expect(dockerfile.indexOf("COPY . .")).toBeGreaterThan(installIndex);
  });
});
