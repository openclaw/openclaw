import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("SRE runtime Dockerfile", () => {
  it("installs vercel for the bundled runtime skillset", async () => {
    const dockerfile = await readFile(
      resolve(repoRoot, "docker", "sre-runtime.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("ARG OPENCLAW_VERCEL_CLI_VERSION=50.37.0");
    expect(dockerfile).toContain(
      'npm install -g --no-fund --no-audit "@tobilu/qmd@${QMD_VERSION}" "vercel@${OPENCLAW_VERCEL_CLI_VERSION}"',
    );
    expect(dockerfile).toContain("vercel --version >/dev/null");
  });

  it("keeps the Vercel CLI pin aligned with the main Dockerfile", async () => {
    const runtimeDockerfile = await readFile(
      resolve(repoRoot, "docker", "sre-runtime.Dockerfile"),
      "utf8",
    );
    const mainDockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf8");

    const runtimeVersion = runtimeDockerfile.match(
      /ARG OPENCLAW_VERCEL_CLI_VERSION=([0-9.]+)/,
    )?.[1];
    const mainVersion = mainDockerfile.match(/ARG OPENCLAW_VERCEL_CLI_VERSION="([0-9.]+)"/)?.[1];

    expect(runtimeVersion).toBeDefined();
    expect(mainVersion).toBeDefined();
    expect(runtimeVersion).toBe(mainVersion);
  });
});
