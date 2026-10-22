import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { scanInstalledApps } from "./installed-apps.js";

const redirectedRoots = vi.hoisted(() => new Map<string, string>());
vi.mock("@openclaw/fs-safe/walk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/walk")>();
  return {
    ...actual,
    walkDirectory: ((root, options) => {
      const target = redirectedRoots.get(root);
      if (!target) {
        throw new Error(`Unowned installed-app fixture root: ${root}`);
      }
      return actual.walkDirectory(target, options);
    }) satisfies typeof actual.walkDirectory,
  };
});

beforeEach(() => {
  mockProcessPlatform("darwin");
});
afterEach(() => {
  redirectedRoots.clear();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function makeFixtureRoot() {
  const root = await fs.realpath(tempDirs.make("openclaw-installed-apps-"));
  const applications = path.join(root, "Applications");
  const userApplications = path.join(root, "UserApplications");
  const systemApplications = path.join(root, "SystemApplications");
  await Promise.all(
    [applications, userApplications, systemApplications].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  redirectedRoots.set("/Applications", applications);
  redirectedRoots.set(path.join(os.homedir(), "Applications"), userApplications);
  redirectedRoots.set("/System/Applications", systemApplications);
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

function expectedApp(root: string, label: string, system = false, bundleId?: string) {
  return {
    label,
    path: path.join(root, `${label}.app`),
    system,
    ...(bundleId ? { bundleId } : {}),
  };
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
    await fs.symlink(
      path.join(roots.applications, "Alpha.app"),
      path.join(roots.userApplications, "Linked.app"),
    );
    const result = await scanInstalledApps();

    expect(result).toEqual({
      status: "ok",
      apps: [
        expectedApp(roots.applications, "Alpha"),
        expectedApp(roots.userApplications, "Linked"),
        expectedApp(roots.systemApplications, "Mail", true),
        expectedApp(roots.userApplications, "No Plist"),
        expectedApp(roots.applications, "Zulu"),
      ],
    });
  });

  it("returns a typed unsupported result off macOS", async () => {
    mockProcessPlatform("linux");
    await expect(scanInstalledApps()).resolves.toEqual({
      status: "unsupported",
      apps: [],
    });
  });

  it.runIf(process.platform === "darwin")(
    "reads only nonempty string identifiers from native plists and retains apps with invalid metadata",
    async () => {
      const roots = await makeFixtureRoot();
      const fixtures: Array<[name: string, value?: string, bundleId?: string, extra?: string]> = [
        ["XML", "<string> \tcom.example.xml\n </string>", "com.example.xml"],
        ["Binary", "<string>com.example.binary</string>", "com.example.binary"],
        [
          "Unrelated Date",
          "<string>com.example.date</string>",
          "com.example.date",
          "<key>BuildDate</key><date>2026-01-01T00:00:00Z</date>",
        ],
        [
          "Large Unrelated Value",
          "<string>com.example.large</string>",
          "com.example.large",
          `<key>Unrelated</key><string>${"x".repeat(2 * 1024 * 1024)}</string>`,
        ],
        ["Numeric String", "<string>42</string>", "42"],
        ["Empty", "<string></string>"],
        ["Whitespace", "<string> \t\n </string>"],
        ["Missing Identifier"],
        ["Integer", "<integer>42</integer>"],
        ["Boolean", "<true/>"],
        ["Array", "<array><string>com.example.array</string></array>"],
        ["Dictionary", "<dict><key>id</key><string>example</string></dict>"],
        ["Data", "<data>ZXhhbXBsZQ==</data>"],
        ["Date Identifier", "<date>2026-01-01T00:00:00Z</date>"],
        ["Oversized Identifier", `<string>${"x".repeat(2 * 1024 * 1024)}</string>`],
      ];
      for (const [name, value, , extra] of fixtures) {
        const identifier = value === undefined ? "" : `<key>CFBundleIdentifier</key>${value}`;
        const plistPath = await createApp(
          roots.applications,
          name,
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>${identifier}${extra ?? ""}</dict></plist>`,
        );
        if (name === "Binary") {
          execFileSync("/usr/bin/plutil", ["-convert", "binary1", plistPath], { timeout: 2_000 });
          expect((await fs.readFile(plistPath)).subarray(0, 8).toString()).toBe("bplist00");
        }
      }
      await createApp(roots.applications, "Malformed", "not a property list");
      await createApp(roots.applications, "No Plist");
      const linkedPath = path.join(roots.userApplications, "Linked.app");
      await fs.symlink(path.join(roots.applications, "XML.app"), linkedPath);

      const result = await scanInstalledApps();

      expect(result.status).toBe("ok");
      if (result.status !== "ok") {
        return;
      }
      expect(result.apps).toHaveLength(fixtures.length + 3);
      const apps = new Map(result.apps.map((app) => [app.label, app]));
      const expectedFixtures: typeof fixtures = [...fixtures, ["Malformed"], ["No Plist"]];
      for (const [name, , bundleId] of expectedFixtures) {
        expect(apps.get(name), name).toEqual(
          expectedApp(roots.applications, name, false, bundleId),
        );
      }
      expect(apps.get("Linked")).toEqual(
        expectedApp(roots.userApplications, "Linked", false, "com.example.xml"),
      );
    },
  );
});
