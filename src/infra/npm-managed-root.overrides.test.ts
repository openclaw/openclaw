import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  readOpenClawManagedNpmRootOverrides,
  upsertManagedNpmRootDependency,
} from "./npm-managed-root.js";

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-npm-overrides-" });
beforeAll(async () => {
  await fixtureRootTracker.setup();
});
afterAll(async () => {
  await fixtureRootTracker.cleanup();
});
async function makeTempRoot(): Promise<string> {
  return fixtureRootTracker.make("case");
}
async function writeFixtureJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value));
}

describe("managed npm scoped overrides", () => {
  it.each(["fresh", "upgrade"])(
    "preserves the shipped exact-parent MSAL policy for a %s managed install",
    async (mode) => {
      const npmRoot = await makeTempRoot();
      if (mode === "upgrade") {
        await writeFixtureJson(path.join(npmRoot, "package.json"), {
          dependencies: { "@openclaw/msteams": "2026.9.1" },
          overrides: { obsolete: "1.0.0", "local-package": "2.0.0" },
          openclaw: { managedOverrides: ["obsolete"] },
        });
      }
      // Read the shipped policy through the same adapter as the installer.
      const managedOverrides = await readOpenClawManagedNpmRootOverrides({
        packageRoot: path.resolve(import.meta.dirname, "../.."),
      });
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "@openclaw/msteams",
        dependencySpec: "2026.10.8",
        managedOverrides,
      });
      const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8"));
      expect(manifest.overrides["@microsoft/teams.apps@2.1.0"]).toEqual({
        "@azure/msal-node": "7.1.1",
      });
      expect(manifest.overrides["@azure/identity@4.13.3"]).toEqual({
        "@azure/msal-node": "7.1.1",
      });
      expect(manifest.overrides).not.toHaveProperty("@azure/msal-node");
      expect(manifest.overrides).not.toHaveProperty(["@microsoft/teams.apps"]);
      expect(manifest.overrides).not.toHaveProperty("@azure/identity");
      expect(manifest.overrides).not.toHaveProperty("obsolete");
      expect(manifest.openclaw.managedOverrides).toEqual(
        expect.arrayContaining(["@microsoft/teams.apps@2.1.0", "@azure/identity@4.13.3"]),
      );
      if (mode === "upgrade") {
        expect(manifest.overrides["local-package"]).toBe("2.0.0");
      }
      // Retiring the policy removes the owned nested rules, not local overrides.
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "@openclaw/msteams",
        dependencySpec: "2026.10.8",
        managedOverrides: {},
      });
      const retired = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8"));
      expect(retired.overrides ?? {}).not.toHaveProperty(["@microsoft/teams.apps@2.1.0"]);
      expect(retired.overrides ?? {}).not.toHaveProperty(["@azure/identity@4.13.3"]);
      if (mode === "upgrade") {
        expect(retired.overrides["local-package"]).toBe("2.0.0");
      }
    },
  );

  it.each([false, true])(
    "merges exact-parent child rules without widening scope (omit aliases: %s)",
    async (omitNpmAliasOverrides) => {
      const npmRoot = await makeTempRoot();
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "plugin",
        dependencySpec: "1.0.0",
        omitNpmAliasOverrides,
        managedOverrides: {
          "parent@1.2.3>child": "2.0.0",
          "parent@1.2.3": "1.2.3",
          "parent@1.2.3>@scope/second": "3.0.0",
          "parent@1.2.3>alias": "npm:replacement@1.0.0",
          "parent@^1.2.3>child": "9.0.0",
          "parent>child": "9.0.0",
          "parent@1.2.3>child>grandchild": "9.0.0",
          "range-target@>1": "2.0.0",
        },
      });
      const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8"));
      expect(manifest.overrides).toEqual({
        "parent@1.2.3": {
          ".": "1.2.3",
          child: "2.0.0",
          "@scope/second": "3.0.0",
          ...(!omitNpmAliasOverrides ? { alias: "npm:replacement@1.0.0" } : {}),
        },
        "range-target@>1": "2.0.0",
      });
    },
  );
});
