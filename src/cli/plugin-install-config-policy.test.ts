import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolvePluginInstallInvalidConfigPolicy,
  type PluginInstallRequestContext,
} from "../plugins/install-config.js";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { resolvePluginInstallPreactionRequest } from "./plugin-install-config-policy.js";

const fixture = vi.hoisted(() => ({
  bundledPath: "",
  entries: [] as OfficialExternalPluginCatalogEntry[],
}));

vi.mock("../plugins/bundled-sources.js", () => ({
  findBundledPluginSource: () => ({ pluginId: "bundled-demo", localPath: fixture.bundledPath }),
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
        argv,
      });
    })
    .action(() => undefined);
  program.parse(argv);
  return request;
}

describe("plugin install recovery source ownership", () => {
  beforeEach(() => {
    fixture.bundledPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-owner-"));
    fs.writeFileSync(
      path.join(fixture.bundledPath, "package.json"),
      JSON.stringify({ openclaw: { install: { allowInvalidConfigRecovery: true } } }),
    );
    fs.writeFileSync(
      path.join(fixture.bundledPath, "openclaw.plugin.json"),
      JSON.stringify({ id: "bundled-demo", configSchema: { type: "object" } }),
    );
    fixture.entries = [];
  });

  afterEach(() => {
    fs.rmSync(fixture.bundledPath, { recursive: true, force: true });
  });

  it.each([false, true].flatMap((allowed) => ["npm:", ""].map((prefix) => ({ allowed, prefix }))))(
    "respects $prefix source ownership with official recovery=$allowed",
    ({ allowed, prefix }) => {
      fixture.entries = [
        {
          name: "@fixture/recovery",
          openclaw: {
            plugin: { id: "official-demo" },
            install: { npmSpec: "@fixture/recovery", allowInvalidConfigRecovery: allowed },
          },
        },
      ];
      const request = parseInstallRequest(`${prefix}@fixture/recovery@1.2.3`);
      expect(request).toMatchObject({
        bundledPluginId: prefix ? "official-demo" : "bundled-demo",
        allowInvalidConfigRecovery: prefix ? allowed : true,
      });
      expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe(
        !prefix || allowed ? "allow-plugin-recovery" : "deny",
      );
    },
  );

  it("uses bundled recovery when no official descriptor owns the spec", () => {
    const request = parseInstallRequest("@fixture/recovery");
    expect(request).toMatchObject({
      bundledPluginId: "bundled-demo",
      allowInvalidConfigRecovery: true,
    });
  });

  it.each([
    { prefix: "", allowed: false },
    { prefix: "", allowed: true },
    { prefix: "file:", allowed: false },
    { prefix: "file:", allowed: true },
  ])(
    "uses local recovery=$allowed through $prefix without borrowing metadata",
    ({ prefix, allowed }) => {
      const localPath = path.join(fixture.bundledPath, "local-plugin");
      fs.mkdirSync(localPath);
      fs.writeFileSync(
        path.join(localPath, "package.json"),
        JSON.stringify({ openclaw: { install: { allowInvalidConfigRecovery: allowed } } }),
      );
      fs.writeFileSync(
        path.join(localPath, "openclaw.plugin.json"),
        JSON.stringify({ id: "local-demo", configSchema: { type: "object" } }),
      );
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
