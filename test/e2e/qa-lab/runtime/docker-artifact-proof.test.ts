import { describe, expect, it } from "vitest";
import { parseDockerArtifactProofOptions } from "./docker-artifact-proof.js";

describe("Docker artifact proof producer", () => {
  it("parses the two canonical artifact lanes", () => {
    expect(
      parseDockerArtifactProofOptions([
        "--artifact-base",
        ".artifacts/proof",
        "--lane",
        "compose-setup",
      ]).lane,
    ).toBe("compose-setup");
    expect(
      parseDockerArtifactProofOptions([
        "--artifact-base",
        ".artifacts/proof",
        "--lane",
        "docker-package-install",
      ]).lane,
    ).toBe("docker-package-install");
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
});
