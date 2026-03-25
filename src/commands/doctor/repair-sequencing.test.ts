import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

describe("doctor repair sequencing", () => {
  it("applies ordered repairs and sanitizes empty-allowlist warnings", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.changeNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("channels.discord.allowFrom: converted 1 numeric ID to strings"),
        expect.stringContaining(
          "channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries",
        ),
      ]),
    );
    expect(result.changeNotes.join("\n")).toContain("bad-keynext -> id:bad-keynext");
    expect(result.changeNotes.join("\n")).not.toContain("\u001B");
    expect(result.changeNotes.join("\n")).not.toContain("\r");
    expect(result.warningNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("channels.signal.accounts.ops-teamnext.dmPolicy"),
      ]),
    );
    expect(result.warningNotes.join("\n")).not.toContain("\u001B");
    expect(result.warningNotes.join("\n")).not.toContain("\r");
  });

  it("emits Discord warnings when unsafe numeric ids block repair", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changeNotes).toEqual([]);
    expect(result.warningNotes).toHaveLength(1);
    expect(result.warningNotes[0]).toContain("cannot be auto-repaired");
    expect(result.warningNotes[0]).toContain("channels.discord.allowFrom[0]");
    expect(result.state.pendingChanges).toBe(false);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual([106232522769186816]);
  });

  it("repairs stale bundled plugin path references before later config repairs", async () => {
    const stalePath = "/pkg/extensions/acpx";
    const nextPath = "/pkg/dist/extensions/acpx";

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            load: { paths: [stalePath] },
            installs: {
              acpx: {
                source: "path",
                spec: "acpx",
                sourcePath: stalePath,
                installPath: stalePath,
              },
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          plugins: {
            load: { paths: [stalePath] },
            installs: {
              acpx: {
                source: "path",
                spec: "acpx",
                sourcePath: stalePath,
                installPath: stalePath,
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      bundledPluginPathOptions: {
        bundledSources: new Map([
          [
            "acpx",
            {
              pluginId: "acpx",
              localPath: nextPath,
            },
          ],
        ]),
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.load?.paths).toEqual([nextPath]);
    expect(result.state.candidate.plugins?.installs?.acpx).toMatchObject({
      source: "path",
      spec: "acpx",
      sourcePath: nextPath,
      installPath: nextPath,
    });
    expect(result.changeNotes).toEqual([
      expect.stringContaining("plugins.installs.acpx.sourcePath"),
    ]);
    expect(result.changeNotes[0]).toContain("plugins.installs.acpx.installPath");
    expect(result.changeNotes[0]).toContain("plugins.load.paths[0]");
  });

  it("repairs stale bundled load paths without install records in the repair sequence", async () => {
    const stalePath = "/pkg/extensions/acpx";
    const nextPath = "/pkg/dist/extensions/acpx";

    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          plugins: {
            load: { paths: [stalePath] },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          plugins: {
            load: { paths: [stalePath] },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
      bundledPluginPathOptions: {
        bundledSources: new Map([
          [
            "acpx",
            {
              pluginId: "acpx",
              localPath: nextPath,
            },
          ],
        ]),
        pathExists: (candidatePath) => candidatePath === nextPath,
      },
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.plugins?.load?.paths).toEqual([nextPath]);
    expect(result.state.candidate.plugins?.installs).toBeUndefined();
    expect(result.changeNotes).toEqual([expect.stringContaining("plugins.load.paths[0]")]);
  });

  it("dedupes symlink-equivalent bundled load paths in the repair sequence", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-paths-"));
    const realPkgRoot = path.join(tempRoot, "real", "pkg");
    const aliasRoot = path.join(tempRoot, "alias");
    const bundledPath = path.join(realPkgRoot, "dist", "extensions", "acpx");
    const stalePath = path.join(aliasRoot, "pkg", "extensions", "acpx");
    const equivalentLoadPath = path.join(aliasRoot, "pkg", "dist", "extensions", "acpx");

    fs.mkdirSync(bundledPath, { recursive: true });
    fs.symlinkSync(path.join(tempRoot, "real"), aliasRoot, "dir");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });

    try {
      const result = await runDoctorRepairSequence({
        state: {
          cfg: {
            plugins: {
              load: { paths: [stalePath, equivalentLoadPath] },
              installs: {
                acpx: {
                  source: "path",
                  spec: "acpx",
                  sourcePath: stalePath,
                  installPath: stalePath,
                },
              },
            },
          } as unknown as OpenClawConfig,
          candidate: {
            plugins: {
              load: { paths: [stalePath, equivalentLoadPath] },
              installs: {
                acpx: {
                  source: "path",
                  spec: "acpx",
                  sourcePath: stalePath,
                  installPath: stalePath,
                },
              },
            },
          } as unknown as OpenClawConfig,
          pendingChanges: false,
          fixHints: [],
        },
        doctorFixCommand: "openclaw doctor --fix",
        bundledPluginPathOptions: {
          bundledSources: new Map([
            [
              "acpx",
              {
                pluginId: "acpx",
                localPath: bundledPath,
              },
            ],
          ]),
        },
      });

      expect(result.state.pendingChanges).toBe(true);
      expect(result.state.candidate.plugins?.load?.paths).toEqual([bundledPath]);
      expect(result.state.candidate.plugins?.installs?.acpx).toMatchObject({
        sourcePath: bundledPath,
        installPath: bundledPath,
      });
      expect(result.changeNotes).toEqual([
        expect.stringContaining("plugins.installs.acpx.sourcePath"),
      ]);
      expect(result.changeNotes[0]).toContain("plugins.installs.acpx.installPath");
      expect(result.changeNotes[0]).toContain("plugins.load.paths[0]");
      expect(result.changeNotes[0]).not.toContain("plugins.load.paths[1]");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
