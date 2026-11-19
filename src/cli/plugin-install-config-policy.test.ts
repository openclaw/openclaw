import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginInstallInvalidConfigPolicy,
  resolvePluginInstallRequestContext,
} from "../plugins/install-config.js";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { resolvePluginInstallPreactionRequest } from "./plugin-install-config-policy.js";

const fixture = vi.hoisted(() => ({ entries: [] as OfficialExternalPluginCatalogEntry[] }));
vi.mock("../plugins/bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/bundled-sources.js")>()),
  findBundledPluginSource: () => undefined,
}));
vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  listOfficialExternalPluginCatalogEntries: () => fixture.entries,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function catalog(allowed = true) {
  fixture.entries = [
    {
      name: "@fixture/recovery",
      openclaw: {
        plugin: { id: "official-demo" },
        install: { npmSpec: "@fixture/recovery", allowInvalidConfigRecovery: allowed },
      },
    },
  ];
}
function parse(spec: string, marketplace?: string) {
  const command = new Command()
    .argument("<spec>")
    .option("--marketplace <source>")
    .action(() => {});
  command.parse([spec, ...(marketplace ? ["--marketplace", marketplace] : [])], { from: "user" });
  return resolvePluginInstallPreactionRequest({
    actionCommand: command,
    commandPath: ["plugins", "install"],
  });
}

it.each([
  ["npm:@fixture/recovery@1.2.3", true, true],
  ["npm:@fixture/recovery@1.2.3", false, true],
  ["official-demo", true, true],
  ["official-demo", false, true],
  ["@fixture/recovery", true, false],
  ["@fixture/recovery@1.2.3", true, false],
  ["clawhub:@fixture/recovery@1.2.3", true, false],
] as const)("respects %s source ownership (recovery=%s)", (spec, allowed, ownsRecovery) => {
  catalog(allowed);
  const request = parse(spec);
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
});

it.each(["npm", "clawhub"] as const)(
  "honors explicit %s source over catalog identity",
  (source) => {
    catalog();
    const result = resolvePluginInstallRequestContext({
      rawSpec: "@fixture/recovery@1.2.3",
      source,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(resolvePluginInstallInvalidConfigPolicy(result.request)).toBe(
      source === "npm" ? "allow-plugin-recovery" : "deny",
    );
  },
);

it.each([
  ["", false],
  ["file:", true],
] as const)("uses local recovery metadata through %s", (prefix, allowed) => {
  catalog();
  const dir = tempDirs.make("openclaw-local-recovery-");
  for (const [name, value] of Object.entries({
    "package.json": { openclaw: { install: { allowInvalidConfigRecovery: allowed } } },
    "openclaw.plugin.json": { id: "local-demo", configSchema: { type: "object" } },
  })) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  const request = parse(prefix + dir);
  expect(request).toMatchObject({
    bundledPluginId: "local-demo",
    allowInvalidConfigRecovery: allowed,
  });
  expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe(
    allowed ? "allow-plugin-recovery" : "deny",
  );
});

it("excludes marketplace requests from catalog recovery", () => {
  catalog();
  const request = parse("@fixture/recovery", "fixture-marketplace");
  expect(request).toMatchObject({ marketplace: "fixture-marketplace", installKind: "plugin" });
  expect(request?.bundledPluginId).toBeUndefined();
  expect(resolvePluginInstallInvalidConfigPolicy(request)).toBe("deny");
});
