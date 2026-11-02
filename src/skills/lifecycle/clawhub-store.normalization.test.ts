import { expect, it } from "vitest";
import { normalizeDownloadedArtifactLock, normalizeSkillFileLock } from "./clawhub-store.js";

it("preserves raw nonblank provenance strings instead of trimming them", () => {
  const artifact = { kind: "archive", sha256: " digest ", integrity: " integrity " };
  const skillFile = { path: " SKILL.md ", sha256: " digest " };
  expect(normalizeDownloadedArtifactLock(artifact)).toEqual(artifact);
  expect(normalizeSkillFileLock(skillFile)).toEqual(skillFile);
});

it.each(["", " \t\n ", null, 42])("rejects blank or non-string provenance fields: %j", (value) => {
  for (const field of ["sha256", "integrity"]) {
    expect(
      normalizeDownloadedArtifactLock({
        kind: "archive",
        sha256: "digest",
        integrity: "integrity",
        [field]: value,
      }),
    ).toBeUndefined();
  }
  for (const field of ["path", "sha256"]) {
    expect(
      normalizeSkillFileLock({ path: "SKILL.md", sha256: "digest", [field]: value }),
    ).toBeUndefined();
  }
});
