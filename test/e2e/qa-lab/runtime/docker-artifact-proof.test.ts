import { describe, expect, it } from "vitest";
import {
  formatDockerArtifactIdentityDetails,
  parseDockerArtifactProofOptions,
} from "./docker-artifact-proof.js";

describe("Docker artifact proof producer", () => {
  it("parses the two canonical artifact lanes", () => {
    expect(
      parseDockerArtifactProofOptions([
        "--artifact-base",
        ".artifacts/proof",
        "--lane",
        "docker-compose-setup",
      ]).lane,
    ).toBe("docker-compose-setup");
    expect(
      parseDockerArtifactProofOptions([
        "--artifact-base",
        ".artifacts/proof",
        "--lane",
        "package-openclaw-for-docker",
      ]).lane,
    ).toBe("package-openclaw-for-docker");
  });

  it("rejects non-artifact Docker lanes", () => {
    expect(() =>
      parseDockerArtifactProofOptions([
        "--artifact-base",
        ".artifacts/proof",
        "--lane",
        "gateway-network",
      ]),
    ).toThrow("unsupported Docker artifact proof lane");
  });

  it("formats package, image, and container identities", () => {
    expect(
      formatDockerArtifactIdentityDetails({
        containers: [
          {
            details: { health: "healthy" },
            id: "container1234567890",
            imageId: "sha256:image",
            name: "gateway",
            role: "gateway",
            state: "running",
          },
        ],
        image: { id: "sha256:image", reference: "openclaw:functional", repoDigests: [] },
        package: {
          fileName: "openclaw-current.tgz",
          name: "openclaw",
          sha256: "a".repeat(64),
          sizeBytes: 42,
          version: "2026.7.6",
        },
        scenarioId: "docker-compose-setup",
      }),
    ).toContain("containers=gateway=container123");
  });
});
