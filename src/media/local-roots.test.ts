import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";

describe("getDefaultMediaLocalRoots", () => {
  it("includes the user home and Desktop directories by default", () => {
    const homeDir = path.resolve(os.homedir());
    const stateDir = resolveStateDir();
    const roots = getDefaultMediaLocalRoots();

    expect(roots).toEqual(
      expect.arrayContaining([
        resolvePreferredOpenClawTmpDir(),
        homeDir,
        path.join(homeDir, "Desktop"),
        path.join(stateDir, "media"),
        path.join(stateDir, "workspace"),
      ]),
    );
  });
});
