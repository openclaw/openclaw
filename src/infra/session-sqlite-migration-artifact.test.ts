import { describe, expect, it } from "vitest";
import {
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";

const identity: MigrationArtifactIdentity = {
  dev: "1",
  ino: "2",
  mtimeNs: "3",
  size: 4,
  sha256: "a".repeat(64),
};

describe("sameMigrationArtifact", () => {
  it("can verify retained artifacts across a device-number change", () => {
    expect(sameMigrationArtifact({ ...identity, dev: "9" }, identity, { ignoreDevice: true })).toBe(
      true,
    );
  });

  it("keeps device identity strict by default", () => {
    expect(sameMigrationArtifact({ ...identity, dev: "9" }, identity)).toBe(false);
  });
});
