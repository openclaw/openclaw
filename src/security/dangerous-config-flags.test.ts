// Covers dangerous config flag detection and reporting.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";

function writeDangerousWorkspacePlugin(workspaceDir: string) {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-danger");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    "export default { id: 'workspace-danger' };\n",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "workspace-danger",
      configSchema: { type: "object", additionalProperties: true },
      configContracts: { dangerousFlags: [{ path: "mode", equals: "danger" }] },
    }),
  );
}

describe("collectEnabledInsecureOrDangerousFlags", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps plugin contract checks enabled for a malformed roster", () => {
    const inheritedWorkspaceDir = tempDirs.make("openclaw-dangerous-inherited-workspace-");
    const explicitWorkspaceDir = tempDirs.make("openclaw-dangerous-explicit-workspace-");
    writeDangerousWorkspacePlugin(inheritedWorkspaceDir);
    const flags = collectEnabledInsecureOrDangerousFlags({
      agents: {
        defaults: { workspace: inheritedWorkspaceDir },
        entries: { alpha: { workspace: explicitWorkspaceDir }, beta: {} },
      },
      plugins: {
        entries: {
          acpx: { config: { permissionMode: "approve-all" } },
          "workspace-danger": { config: { mode: "danger" } },
        },
      },
    });

    expect(flags).toContain("plugins.entries.acpx.config.permissionMode=approve-all");
    expect(flags).toContain("plugins.entries.workspace-danger.config.mode=danger");
  });

  it("uses the implicit main workspace for a rosterless compatibility config", () => {
    const workspaceDir = tempDirs.make("openclaw-dangerous-rosterless-");
    writeDangerousWorkspacePlugin(workspaceDir);

    const flags = collectEnabledInsecureOrDangerousFlags({
      agents: { defaults: { workspace: workspaceDir } },
      plugins: {
        entries: { "workspace-danger": { config: { mode: "danger" } } },
      },
    });

    expect(flags).toContain("plugins.entries.workspace-danger.config.mode=danger");
  });

  it("ignores plugin config values that are not declared as dangerous", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts(
        {
          plugins: {
            entries: {
              other: {
                config: {
                  mode: "safe",
                },
              },
            },
          },
        },
        {
          configContractsById: new Map([
            [
              "other",
              {
                configContracts: {
                  dangerousFlags: [{ path: "mode", equals: "danger" }],
                },
              },
            ],
          ]),
        },
      ),
    ).toStrictEqual([]);
  });

  it("collects dangerous sandbox, hook, browser, and fs flags", () => {
    const flags = collectEnabledInsecureOrDangerousFlagsFromContracts({
      agents: {
        defaults: {
          sandbox: {
            docker: {
              dangerouslyAllowReservedContainerTargets: true,
              dangerouslyAllowContainerNamespaceJoin: true,
            },
          },
        },
        entries: {
          worker: {
            sandbox: {
              docker: {
                dangerouslyAllowExternalBindSources: true,
              },
            },
          },
        },
      },
      hooks: {
        allowRequestSessionKey: true,
      },
      browser: {
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: true,
        },
      },
      tools: {
        fs: {
          workspaceOnly: false,
        },
      },
    });

    expect(flags).toStrictEqual([
      "hooks.allowRequestSessionKey=true",
      "browser.ssrfPolicy.dangerouslyAllowPrivateNetwork=true",
      "tools.fs.workspaceOnly=false",
      "agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets=true",
      "agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true",
      "agents.entries.worker.sandbox.docker.dangerouslyAllowExternalBindSources=true",
    ]);
  });

  it("collects configured security audit suppressions as a dangerous flag", () => {
    expect(
      collectEnabledInsecureOrDangerousFlagsFromContracts({
        security: {
          audit: {
            suppressions: [{ checkId: "plugins.code_safety" }],
          },
        },
      }),
    ).toContain("security.audit.suppressions configured (1)");
  });

  it("keeps legacy list indices for id-less dangerous sandbox rows", () => {
    const cfg: Omit<OpenClawConfig, "agents"> & {
      agents?: NonNullable<OpenClawConfig["agents"]> & { list?: Record<string, unknown>[] };
    } = {
      agents: {
        list: [
          {
            id: "worker",
          },
          {
            sandbox: {
              docker: {
                dangerouslyAllowContainerNamespaceJoin: true,
              },
            },
          },
        ],
      },
    };
    expect(collectEnabledInsecureOrDangerousFlagsFromContracts(cfg)).toContain(
      "agents.list.1.sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true",
    );
  });
});
