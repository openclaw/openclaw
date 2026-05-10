import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("azd deploy from-package helper", () => {
  it("builds, pushes, and deploys OpenClaw from the current azd environment", () => {
    const script = readFileSync("scripts/azd-deploy-openclaw-from-package.mjs", "utf8");

    expect(script).toContain("WINDOWS_COMMANDS");
    expect(script).toContain('az: "az.cmd"');
    expect(script).toContain('azd: "azd.exe"');
    expect(script).toContain('docker: "docker.exe"');
    expect(script).toContain("resolveCommand(command)");
    expect(script).toContain('azd", ["env", "get-values"]');
    expect(script).toContain("AZURE_CONTAINER_REGISTRY_ENDPOINT");
    expect(script).toContain("SERVICE_OPENCLAW_IMAGE_NAME");
    expect(script).toContain("DOCKER_BUILDKIT");
    expect(script).toContain('"acr", "login"');
    expect(script).toContain('"build", "-f", "Dockerfile"');
    expect(script).toContain('"push", imageRef');
    expect(script).toContain('"deploy", "openclaw", "--from-package", imageRef, "--no-prompt"');
    expect(script).toContain("--dry-run");
  });

  it("exposes the helper through package.json", () => {
    const packageJson = readFileSync("package.json", "utf8");

    expect(packageJson).toContain(
      '"deploy:azure:openclaw:from-package": "node scripts/azd-deploy-openclaw-from-package.mjs"',
    );
  });
});
