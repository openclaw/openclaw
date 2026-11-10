import fs from "node:fs";
import { vi } from "vitest";
import * as profileAliases from "../../state/user-profile-list.js";

// Both observers pass through; distinguish alias work from unrelated store-path resolution.
export function observeAliasRootProbes(stateDir: string) {
  let inAliasRead = false;
  const probes = { aliasRootProbes: 0, otherRootProbes: 0 };
  const readAliases = profileAliases.readUserProfileAliases;
  const exists = fs.existsSync;
  const aliasSpy = vi
    .spyOn(profileAliases, "readUserProfileAliases")
    .mockImplementation((...args) => {
      inAliasRead = true;
      try {
        return readAliases(...args);
      } finally {
        inAliasRead = false;
      }
    });
  const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
    if (candidate === stateDir) {
      probes[inAliasRead ? "aliasRootProbes" : "otherRootProbes"] += 1;
    }
    return exists(candidate);
  });
  return {
    finish() {
      existsSpy.mockRestore();
      aliasSpy.mockRestore();
      return probes;
    },
  };
}
