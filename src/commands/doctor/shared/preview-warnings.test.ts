import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bundledSources from "../../../plugins/bundled-sources.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { collectDoctorPreviewWarnings } from "./preview-warnings.js";

function manifest(id: string): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
  };
}

describe("doctor preview warnings", () => {
  beforeEach(() => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [manifest("discord")],
      diagnostics: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects provider and shared preview warnings", () => {
    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          telegram: {
            allowFrom: ["@alice"],
          },
          signal: {
            dmPolicy: "open",
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("Telegram allowFrom contains 1 non-numeric entries"),
      expect.stringContaining('channels.signal.allowFrom: set to ["*"]'),
    ]);
  });

  it("sanitizes empty-allowlist warning paths before returning preview output", () => {
    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        channels: {
          signal: {
            accounts: {
              "ops\u001B[31m-team\u001B[0m\r\nnext": {
                dmPolicy: "allowlist",
              },
            },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("channels.signal.accounts.ops-teamnext.dmPolicy"),
    ]);
    expect(warnings[0]).not.toContain("\u001B");
    expect(warnings[0]).not.toContain("\r");
  });

  it("includes stale plugin config warnings", () => {
    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          allow: ["acpx"],
          entries: {
            acpx: { enabled: true },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('plugins.allow: stale plugin reference "acpx"'),
    ]);
    expect(warnings[0]).toContain("plugins.entries.acpx");
    expect(warnings[0]).toContain('Run "openclaw doctor --fix"');
    expect(warnings[0]).not.toContain("Auto-removal is paused");
  });

  it("includes bundled plugin load path migration warnings", () => {
    const packageRoot = path.resolve("app-node-modules", "openclaw");
    const legacyPath = path.join(packageRoot, "extensions", "feishu");
    const bundledPath = path.join(packageRoot, "dist", "extensions", "feishu");
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [manifest("feishu")],
      diagnostics: [],
    });
    vi.spyOn(bundledSources, "resolveBundledPluginSources").mockReturnValue(
      new Map([
        [
          "feishu",
          {
            pluginId: "feishu",
            localPath: bundledPath,
            npmSpec: "@openclaw/feishu",
          },
        ],
      ]),
    );

    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          load: {
            paths: [legacyPath],
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining(`plugins.load.paths: legacy bundled plugin path "${legacyPath}"`),
    ]);
    expect(warnings[0]).toContain('Run "openclaw doctor --fix"');
  });

  it("warns but skips auto-removal when plugin discovery has errors", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [],
      diagnostics: [
        { level: "error", message: "plugin path not found: /missing", source: "/missing" },
      ],
    });

    const warnings = collectDoctorPreviewWarnings({
      cfg: {
        plugins: {
          allow: ["acpx"],
          entries: {
            acpx: { enabled: true },
          },
        },
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('plugins.allow: stale plugin reference "acpx"'),
    ]);
    expect(warnings[0]).toContain("Auto-removal is paused");
    expect(warnings[0]).toContain('rerun "openclaw doctor --fix"');
  });
});
