import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { scanInstalledApps } from "./installed-apps.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeFixtureRoot(): Promise<{
  root: string;
  applications: string;
  userApplications: string;
  systemApplications: string;
}> {
  const root = await fs.realpath(tempDirs.make("openclaw-installed-apps-"));
  const applications = path.join(root, "Applications");
  const userApplications = path.join(root, "UserApplications");
  const systemApplications = path.join(root, "SystemApplications");
  await Promise.all(
    [applications, userApplications, systemApplications].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  return { root, applications, userApplications, systemApplications };
}

async function createApp(root: string, name: string, plist?: string): Promise<string> {
  const contents = path.join(root, `${name}.app`, "Contents");
  await fs.mkdir(contents, { recursive: true });
  const plistPath = path.join(contents, "Info.plist");
  if (plist !== undefined) {
    await fs.writeFile(plistPath, plist);
  }
  return plistPath;
}

describe("scanInstalledApps", () => {
  it("scans app roots, filters copies and system apps, and sorts deterministically", async () => {
    const roots = await makeFixtureRoot();
    await Promise.all([
      createApp(roots.applications, "Zulu"),
      createApp(roots.applications, "Alpha"),
      createApp(roots.applications, "Alpha previous"),
      createApp(roots.applications, "Zulu-pre-update"),
      createApp(roots.userApplications, "No Plist"),
      createApp(roots.systemApplications, "Mail"),
      createApp(roots.systemApplications, "Calculator"),
      fs.mkdir(path.join(roots.applications, "Not An App")),
    ]);

    const result = await scanInstalledApps({ platform: "darwin", roots });

    expect(result).toEqual({
      status: "ok",
      apps: [
        {
          label: "Alpha",
          path: path.join(roots.applications, "Alpha.app"),
          system: false,
        },
        {
          label: "Mail",
          path: path.join(roots.systemApplications, "Mail.app"),
          system: true,
        },
        {
          label: "No Plist",
          path: path.join(roots.userApplications, "No Plist.app"),
          system: false,
        },
        {
          label: "Zulu",
          path: path.join(roots.applications, "Zulu.app"),
          system: false,
        },
      ],
    });
  });

  it("includes symlinked app bundles", async () => {
    const roots = await makeFixtureRoot();
    await createApp(roots.applications, "RealTarget");
    await fs.symlink(
      path.join(roots.applications, "RealTarget.app"),
      path.join(roots.userApplications, "Linked.app"),
    );
    const result = await scanInstalledApps({ platform: "darwin", roots });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.apps.map((app) => app.label)).toContain("Linked");
    }
  });

  it("returns a typed unsupported result off macOS", async () => {
    await expect(scanInstalledApps({ platform: "linux" })).resolves.toEqual({
      status: "unsupported",
      platform: "linux",
      apps: [],
    });
  });

  it.runIf(process.platform === "darwin")(
    "reads only nonempty string identifiers from native plists and retains apps with invalid metadata",
    async () => {
      const roots = await makeFixtureRoot();
      const fixtures: Array<{
        name: string;
        value?: string;
        extra?: string;
        bundleId?: string;
        binary?: boolean;
      }> = [
        {
          name: "XML",
          value: "<string> \tcom.example.xml\n </string>",
          bundleId: "com.example.xml",
        },
        {
          name: "Binary",
          value: "<string>com.example.binary</string>",
          bundleId: "com.example.binary",
          binary: true,
        },
        {
          name: "Unrelated Date",
          value: "<string>com.example.date</string>",
          extra: "<key>BuildDate</key><date>2026-01-01T00:00:00Z</date>",
          bundleId: "com.example.date",
        },
        {
          name: "Large Unrelated Value",
          value: "<string>com.example.large</string>",
          extra: `<key>Unrelated</key><string>${"x".repeat(2 * 1024 * 1024)}</string>`,
          bundleId: "com.example.large",
        },
        { name: "Numeric String", value: "<string>42</string>", bundleId: "42" },
        { name: "Empty", value: "<string></string>" },
        { name: "Whitespace", value: "<string> \t\n </string>" },
        { name: "Missing Identifier" },
        { name: "Integer", value: "<integer>42</integer>" },
        { name: "Boolean", value: "<true/>" },
        { name: "Array", value: "<array><string>com.example.array</string></array>" },
        { name: "Dictionary", value: "<dict><key>id</key><string>example</string></dict>" },
        { name: "Data", value: "<data>ZXhhbXBsZQ==</data>" },
        { name: "Date Identifier", value: "<date>2026-01-01T00:00:00Z</date>" },
        { name: "Oversized Identifier", value: `<string>${"x".repeat(2 * 1024 * 1024)}</string>` },
      ];
      for (const fixture of fixtures) {
        const identifier =
          fixture.value === undefined ? "" : `<key>CFBundleIdentifier</key>${fixture.value}`;
        const plistPath = await createApp(
          roots.applications,
          fixture.name,
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${identifier}${fixture.extra ?? ""}</dict></plist>`,
        );
        if (fixture.binary) {
          execFileSync("/usr/bin/plutil", ["-convert", "binary1", plistPath], { timeout: 2_000 });
          expect((await fs.readFile(plistPath)).subarray(0, 8).toString()).toBe("bplist00");
        }
      }
      await createApp(roots.applications, "Malformed", "not a property list");
      await createApp(roots.applications, "No Plist");
      const linkedPath = path.join(roots.userApplications, "Linked.app");
      await fs.symlink(path.join(roots.applications, "XML.app"), linkedPath);

      const result = await scanInstalledApps({ roots });

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.apps).toHaveLength(fixtures.length + 3);
      const apps = new Map(result.apps.map((app) => [app.label, app]));
      for (const fixture of [
        ...fixtures,
        { name: "Malformed", bundleId: undefined },
        { name: "No Plist", bundleId: undefined },
      ]) {
        expect(apps.get(fixture.name), fixture.name).toEqual({
          label: fixture.name,
          ...(fixture.bundleId ? { bundleId: fixture.bundleId } : {}),
          path: path.join(roots.applications, `${fixture.name}.app`),
          system: false,
        });
      }
      expect(apps.get("Linked")).toEqual({
        label: "Linked",
        bundleId: "com.example.xml",
        path: linkedPath,
        system: false,
      });
    },
  );
});
