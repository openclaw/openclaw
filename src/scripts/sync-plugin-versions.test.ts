import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("syncPluginVersions", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves workspace mullusi devDependencies while bumping plugin host constraints", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullusi-sync-plugin-versions-"));
    tempDirs.push(rootDir);

    writeJson(path.join(rootDir, "package.json"), {
      name: "mullusi",
      version: "2026.4.1",
    });
    writeJson(path.join(rootDir, "extensions/bluebubbles/package.json"), {
      name: "@mullusi/bluebubbles",
      version: "2026.3.30",
      devDependencies: {
        mullusi: "workspace:*",
      },
      peerDependencies: {
        mullusi: ">=2026.3.30",
      },
      mullusi: {
        install: {
          minHostVersion: ">=2026.3.30",
        },
        compat: {
          pluginApi: ">=2026.3.30",
        },
        build: {
          mullusiVersion: "2026.3.30",
        },
      },
    });

    const summary = syncPluginVersions(rootDir);
    const updatedPackage = JSON.parse(
      fs.readFileSync(path.join(rootDir, "extensions/bluebubbles/package.json"), "utf8"),
    ) as {
      version?: string;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      mullusi?: {
        install?: {
          minHostVersion?: string;
        };
        compat?: {
          pluginApi?: string;
        };
        build?: {
          mullusiVersion?: string;
        };
      };
    };

    expect(summary.updated).toContain("@mullusi/bluebubbles");
    expect(updatedPackage.version).toBe("2026.4.1");
    expect(updatedPackage.devDependencies?.mullusi).toBe("workspace:*");
    expect(updatedPackage.peerDependencies?.mullusi).toBe(">=2026.4.1");
    expect(updatedPackage.mullusi?.install?.minHostVersion).toBe(">=2026.4.1");
    expect(updatedPackage.mullusi?.compat?.pluginApi).toBe(">=2026.4.1");
    expect(updatedPackage.mullusi?.build?.mullusiVersion).toBe("2026.4.1");
  });
});
