import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as runtimePaths from "../../daemon/runtime-paths.js";
import * as daemonService from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as gatewaySupervision from "../../infra/gateway-supervision.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import { defaultRuntime } from "../../runtime.js";
import * as shared from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import { updateCommand } from "./update-command.js";

const { fixture } = installFreshUpdateFixture();
const cases = [
  { name: "no restart", restart: false, compatible: false, current: false, refresh: true },
  { name: "replacement", restart: true, compatible: false, current: false, refresh: true },
  { name: "compatible", restart: true, compatible: true, current: false, refresh: true },
  {
    name: "foreign service",
    restart: true,
    compatible: false,
    current: false,
    refresh: true,
    owned: false,
  },
  { name: "current replacement", restart: true, compatible: false, current: true, refresh: true },
  {
    name: "current sealed service",
    restart: true,
    compatible: false,
    current: true,
    refresh: false,
  },
  { name: "current no restart", restart: false, compatible: false, current: true, refresh: true },
  {
    name: "current stopped service",
    restart: true,
    compatible: false,
    current: true,
    refresh: true,
    running: false,
  },
];

it.each(cases.flatMap((entry) => [true, false].map((json) => Object.assign({}, entry, { json }))))(
  "previews package runtime admission without mutation ($name, json=$json)",
  async ({ restart, compatible, current, refresh, json, owned = true, running = true }) => {
    fixture.managedServiceNodeRunner = "/service/node";
    vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
    vi.spyOn(gatewaySupervision, "assertGatewayServiceMutationAllowed").mockReturnValue();
    const service = createMockGatewayService({
      isLoaded: async () => true,
      readRuntime: async () => ({
        status: running ? "running" : "stopped",
        systemd: { managerUid: 2001 },
      }),
    });
    vi.spyOn(service, "readCommand").mockResolvedValue(
      owned
        ? {
            programArguments: [
              "/service/node",
              path.join(fixture.root, "dist/index.mjs"),
              "gateway",
            ],
          }
        : null,
    );
    vi.spyOn(daemonService, "resolveGatewayService").mockReturnValue(service);
    vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockImplementation(async (node) => ({
      status: "supported",
      version: compatible || node === "/current/node" ? "26.1.0" : "24.16.0",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.53.0", text: true, blob: true, json: true },
    }));
    vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
      ...targetMetadata,
      nodeEngine: ">=26.1.0",
    });
    if (current) {
      fs.writeFileSync(
        path.join(fixture.root, "package.json"),
        JSON.stringify({ name: "openclaw", version: targetMetadata.version }),
      );
      const inspect = vi
        .mocked(databaseContext.inspectUpdateDatabaseContexts)
        .getMockImplementation()!;
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockImplementation(
        async (params) => ({
          ...(await inspect(params)),
          service: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running,
            serviceNodeRunner: fixture.managedServiceNodeRunner,
            serviceUpdateVerdict: {
              kind: "owned",
              root: fixture.root,
              fingerprint: "fixture",
              refreshDefinition: refresh,
            },
          },
        }),
      );
    }
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const manifest = fs.readFileSync(path.join(fixture.root, "package.json"));
    const opts = { tag: targetMetadata.version, yes: true, json, restart };

    await updateCommand({ ...opts, dryRun: true });

    const notes = json
      ? JSON.stringify(vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0])
      : log.mock.calls.flat().join("\n");
    const replacement = !compatible && restart && owned && (!current || (running && refresh));
    if (!compatible && !replacement) {
      expect(notes).toContain("Would refuse update: Node 24.16.0 at /service/node is incompatible");
      expect(notes).toContain("The requested package requires >=26.1.0.");
    } else if (replacement) {
      expect(notes).toContain("/service/node");
      expect(notes).toContain("/current/node");
      expect(notes).toContain("Would replace");
    } else {
      expect(notes).not.toContain("Would refuse");
      expect(notes).not.toContain("Would replace");
    }
    expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(fs.readFileSync(path.join(fixture.root, "package.json"))).toEqual(manifest);

    if (!current) {
      await expect(updateCommand({ ...opts, json: true })).rejects.toBeInstanceOf(Error);
      if (compatible || replacement) {
        expect(packageUpdate.stagePackageInstallUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: replacement ? "/current/node" : "/service/node" }),
        );
      } else {
        expect(defaultRuntime.writeJson).toHaveBeenLastCalledWith(
          expect.objectContaining({ reason: "node-runtime-preflight" }),
        );
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
      }
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
    }
  },
);
