import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test.runIf(process.platform !== "win32")(
  "keeps exact custody across POSIX lexical and physical directory spellings",
  () => {
    const root = tempDirs.make("session-store-posix-alias-");
    const physicalDir = path.join(root, "physical");
    const aliasDir = path.join(root, "alias");
    fs.mkdirSync(physicalDir);
    fs.symlinkSync(physicalDir, aliasDir, "junction");
    const physicalPath = path.join(fs.realpathSync(physicalDir), "openclaw-agent.sqlite");
    const aliasPath = path.join(aliasDir, "openclaw-agent.sqlite");
    fs.writeFileSync(physicalPath, "");

    const candidate = { path: aliasPath, physicalPath };
    expect(assertSessionStoreReadCandidate(physicalPath, [candidate])).toBe(physicalPath);
  },
);

test.runIf(process.platform !== "win32")(
  "keeps sibling-family custody anchored to the captured lexical directory",
  () => {
    const root = tempDirs.make("session-store-posix-family-");
    const physicalDir = path.join(root, "physical");
    const aliasDir = path.join(root, "alias");
    fs.mkdirSync(physicalDir);
    fs.symlinkSync(physicalDir, aliasDir, "junction");
    const physicalPath = path.join(fs.realpathSync(physicalDir), "openclaw-agent.sqlite");
    fs.writeFileSync(physicalPath, "");

    const candidate = {
      path: path.join(aliasDir, "openclaw-agent.sqlite"),
      physicalPath,
      scope: "sibling-family" as const,
    };
    expect(() => assertSessionStoreReadCandidate(physicalPath, [candidate])).toThrow(
      /outside captured discovery custody/,
    );
  },
);
