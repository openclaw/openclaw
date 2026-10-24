import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "../plugins/install-config.js";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { resolvePluginInstallPreactionRequest } from "./plugin-install-config-policy.js";

const fixture = vi.hoisted(() => ({
  bundledPath: "",
  entries: [] as OfficialExternalPluginCatalogEntry[],
}));

vi.mock("../plugins/bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/bundled-sources.js")>()),
  findBundledPluginSource: ({ lookup }: { lookup: { kind: string; value: string } }) =>
    lookup.kind === "pluginId" && lookup.value === "bundled-demo"
      ? { pluginId: "bundled-demo", localPath: fixture.bundledPath }
      : undefined,
}));

vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  listOfficialExternalPluginCatalogEntries: () => fixture.entries,
}));

function parseInstallRequest(
  spec: string,
  marketplace?: string,
): PluginInstallRequestContext | null {
  const argv = ["node", "openclaw", "plugins", "install", spec];
  if (marketplace) {
    argv.push("--marketplace", marketplace);
  }
  let request: PluginInstallRequestContext | null = null;
  const program = new Command();
  program
    .command("plugins")
    .command("install")
    .argument("<spec>")
    .option("--marketplace <source>")
    .hook("preAction", (_command, actionCommand) => {
      request = resolvePluginInstallPreactionRequest({
        actionCommand,
        commandPath: ["plugins", "install"],
      });
    })
    .action(() => undefined);
  program.parse(argv);
  return request;
}

function writePlugin(dir: string, id: string, allowed: boolean) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, value] of Object.entries({
    "package.json": { openclaw: { install: { allowInvalidConfigRecovery: allowed } } },
    "openclaw.plugin.json": { id, configSchema: { type: "object" } },
  })) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  }
}

describe("plugin install recovery source ownership", () => {
  beforeEach(() => {
    fixture.bundledPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-owner-"));
    writePlugin(fixture.bundledPath, "bundled-demo", true);
    fixture.entries = [];
  });

  afterEach(() => {
    fs.rmSync(fixture.bundledPath, { recursive: true, force: true });
  });

  it.each(
    [false, true].flatMap((allowed) =>
      [
        { spec: "npm:@fixture/recovery@1.2.3", ownsRecovery: true },
        { spec: "official-demo", ownsRecovery: true },
        { spec: "@fixture/recovery", ownsRecovery: false },
        { spec: "@fixture/recovery@1.2.3", ownsRecovery: false },
        { spec: "clawhub:@fixture/recovery@1.2.3", ownsRecovery: false },
      ].map((request) => Object.assign({ allowed }, request)),
    ),
  )(
    "respects $spec source ownership with official recovery=$allowed",
    ({ allowed, spec, ownsRecovery }) => {
      fixture.entries = [
        {
          name: "@fixture/recovery",
          openclaw: {
            plugin: { id: "official-demo" },
            install: { npmSpec: "@fixture/recovery", allowInvalidConfigRecovery: allowed },
          },
        },
      ];
      const request = parseInstallRequest(spec);
      expect(request).toEqual({
        rawSpec: spec,
        ...(ownsRecovery
          ? {
              installKind: "plugin",
              bundledPluginId: "official-demo",
              allowInvalidConfigRecovery: allowed,
            }
          : {}),
      });
      expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe(
        ownsRecovery && allowed ? "allow-plugin-recovery" : "deny",
      );

      if (spec === "@fixture/recovery@1.2.3") {
        for (const source of ["npm", "clawhub"] as const) {
          const selected = resolvePluginInstallRequestContext({ rawSpec: spec, source });
          expect(selected).toMatchObject({ ok: true });
          if (!selected.ok) {
            throw new Error(selected.error);
          }
          expect(resolvePluginInstallInvalidConfigPolicy(selected.request)).toBe(
            source === "npm" && allowed ? "allow-plugin-recovery" : "deny",
          );
        }
      }
    },
  );

  it("uses bundled recovery for a canonical plugin ID", () => {
    const request = parseInstallRequest("bundled-demo");
    expect(request).toMatchObject({
      bundledPluginId: "bundled-demo",
      allowInvalidConfigRecovery: true,
    });
  });

  it.each([
    { prefix: "", allowed: false },
    { prefix: "file:", allowed: true },
  ])(
    "uses local recovery=$allowed through $prefix without borrowing metadata",
    ({ prefix, allowed }) => {
      const localPath = path.join(fixture.bundledPath, "local-plugin");
      writePlugin(localPath, "local-demo", allowed);
      const request = parseInstallRequest(`${prefix}${localPath}`);
      expect(request).toMatchObject({
        bundledPluginId: "local-demo",
        allowInvalidConfigRecovery: allowed,
      });
      expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe(
        allowed ? "allow-plugin-recovery" : "deny",
      );
    },
  );

  it.each(["file:@fixture/recovery", "FILE:@fixture/recovery"])(
    "does not borrow catalog recovery for missing local source %s",
    (spec) => {
      const request = parseInstallRequest(spec);
      expect(request?.bundledPluginId).toBeUndefined();
      expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe("deny");
    },
  );

  it("excludes marketplace requests from bundled recovery", () => {
    const request = parseInstallRequest("@fixture/recovery", "fixture-marketplace");
    expect(request).toMatchObject({ marketplace: "fixture-marketplace", installKind: "plugin" });
    expect(request?.bundledPluginId).toBeUndefined();
    expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe("deny");
  });
});
