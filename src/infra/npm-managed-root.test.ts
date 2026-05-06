import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectManagedNpmRootOpenClawPoison,
  repairManagedNpmRootOpenClawPeer,
  removeManagedNpmRootDependency,
  readManagedNpmRootInstalledDependency,
  resolveManagedNpmRootDependencySpec,
  upsertManagedNpmRootDependency,
} from "./npm-managed-root.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-managed-root-"));
  tempDirs.push(dir);
  return dir;
}

async function writePoisonedRoot(npmRoot: string): Promise<void> {
  await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
  await fs.writeFile(
    path.join(npmRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          openclaw: "2026.5.4",
          "@openclaw/discord": "2026.5.4",
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(npmRoot, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              openclaw: "2026.5.4",
              "@openclaw/discord": "2026.5.4",
            },
          },
          "node_modules/openclaw": {
            version: "2026.5.4",
          },
          "node_modules/@openclaw/discord": {
            version: "2026.5.4",
          },
        },
        dependencies: {
          openclaw: {
            version: "2026.5.4",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(npmRoot, "node_modules", "openclaw", "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.5.4" })}\n`,
  );
}

async function removeRootOpenClawState(npmRoot: string): Promise<void> {
  const manifestPath = path.join(npmRoot, "package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (manifest.dependencies) {
    delete manifest.dependencies.openclaw;
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const lockPath = path.join(npmRoot, "package-lock.json");
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
    dependencies?: Record<string, unknown>;
    packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
  };
  if (lock.packages?.[""]?.dependencies) {
    delete lock.packages[""].dependencies.openclaw;
  }
  delete lock.packages?.["node_modules/openclaw"];
  delete lock.dependencies?.openclaw;
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await fs.rm(path.join(npmRoot, "node_modules", "openclaw"), {
    recursive: true,
    force: true,
  });
}

function createRepairParams(
  npmRoot: string,
  overrides: Partial<Parameters<typeof repairManagedNpmRootOpenClawPeer>[0]> = {},
): Parameters<typeof repairManagedNpmRootOpenClawPeer>[0] {
  return {
    defaultNpmRoot: npmRoot,
    env: {},
    hostPackageRoot: path.join(os.tmpdir(), "openclaw-host-root"),
    npmRoot,
    runCommand: async () => ({ code: 0, stderr: "", stdout: "" }),
    timeoutMs: 1_000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("managed npm root", () => {
  it("keeps existing plugin dependencies when adding another managed plugin", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.2",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("does not overwrite a present malformed package manifest", async () => {
    const npmRoot = await makeTempRoot();
    const manifestPath = path.join(npmRoot, "package.json");
    await fs.writeFile(manifestPath, "{not-json", "utf8");

    await expect(
      upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "@openclaw/feishu",
        dependencySpec: "2026.5.2",
      }),
    ).rejects.toThrow();

    await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe("{not-json");
  });

  it("pins managed dependencies to the resolved version", () => {
    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord@stable",
          selector: "stable",
          selectorKind: "tag",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");

    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord",
          selectorKind: "none",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");
  });

  it("reads installed dependency metadata from package-lock", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/@openclaw/discord": {
              version: "2026.5.2",
              resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
              integrity: "sha512-discord",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    await expect(
      readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: "@openclaw/discord",
      }),
    ).resolves.toEqual({
      version: "2026.5.2",
      resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
      integrity: "sha512-discord",
    });
  });

  it("removes one managed dependency without dropping unrelated metadata", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
            "@openclaw/voice-call": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await removeManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/voice-call",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("repairs stale managed openclaw root state with native npm commands first", async () => {
    const npmRoot = await makeTempRoot();
    await writePoisonedRoot(npmRoot);
    const runCommand = vi.fn(async (argv: string[]) => {
      if (argv[1] === "uninstall") {
        await removeRootOpenClawState(npmRoot);
      }
      return { code: 0, stderr: "", stdout: "" };
    });

    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(npmRoot, { runCommand })),
    ).resolves.toMatchObject({ changed: true, status: "repaired" });

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(["npm", "uninstall", "openclaw"]),
      expect.objectContaining({ cwd: npmRoot }),
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["npm", "prune"]),
      expect.objectContaining({ cwd: npmRoot }),
    );

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      openclawManagedPluginRoot?: boolean;
    };
    expect(manifest.dependencies).toEqual({
      "@openclaw/discord": "2026.5.4",
    });
    expect(manifest.openclawManagedPluginRoot).toBe(true);
    const lockfile = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
      dependencies?: Record<string, unknown>;
    };
    expect(lockfile.packages?.[""]?.dependencies).toEqual({
      "@openclaw/discord": "2026.5.4",
    });
    expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
    expect(lockfile.packages?.["node_modules/@openclaw/discord"]?.version).toBe("2026.5.4");
    expect(lockfile.dependencies?.openclaw).toBeUndefined();
    await expect(fs.lstat(path.join(npmRoot, "node_modules", "openclaw"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses quarantine fallback when native npm leaves stale root state behind", async () => {
    const npmRoot = await makeTempRoot();
    await writePoisonedRoot(npmRoot);
    const runCommand = vi.fn(async () => ({ code: 1, stderr: "still conflicted", stdout: "" }));

    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(npmRoot, { now: () => 123, runCommand })),
    ).resolves.toMatchObject({ changed: true, status: "repaired" });

    await expect(inspectManagedNpmRootOpenClawPoison({ npmRoot })).resolves.toMatchObject({
      hasPoison: false,
    });
    await expect(
      fs.lstat(path.join(npmRoot, ".openclaw-quarantine", "node_modules-openclaw-123")),
    ).resolves.toBeDefined();
  });

  it("fallback removes root optional and peer openclaw entries and quarantines corrupt locks", async () => {
    const npmRoot = await makeTempRoot();
    await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          optionalDependencies: {
            openclaw: "2026.5.4",
          },
          peerDependencies: {
            openclaw: ">=2026.5.4",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(path.join(npmRoot, "package-lock.json"), "{not-json\n");

    await expect(
      repairManagedNpmRootOpenClawPeer(
        createRepairParams(npmRoot, {
          now: () => 789,
          runCommand: async () => ({ code: 1, stderr: "native failed", stdout: "" }),
        }),
      ),
    ).resolves.toMatchObject({ changed: true, status: "repaired" });

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.optionalDependencies).toEqual({});
    expect(manifest.peerDependencies).toEqual({});
    await expect(
      fs.lstat(path.join(npmRoot, ".openclaw-quarantine", "package-lock-json-789")),
    ).resolves.toBeDefined();
    await expect(
      fs.lstat(path.join(npmRoot, ".openclaw-quarantine", "node_modules-openclaw-789")),
    ).resolves.toBeDefined();
  });

  it("repairs lock-only and filesystem-only stale root state", async () => {
    const lockOnlyRoot = await makeTempRoot();
    await fs.writeFile(path.join(lockOnlyRoot, "package.json"), "{}\n");
    await fs.writeFile(
      path.join(lockOnlyRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/openclaw": { version: "2026.5.4" },
          },
        },
        null,
        2,
      )}\n`,
    );
    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(lockOnlyRoot)),
    ).resolves.toMatchObject({ status: "repaired" });
    await expect(
      inspectManagedNpmRootOpenClawPoison({ npmRoot: lockOnlyRoot }),
    ).resolves.toMatchObject({
      hasPoison: false,
    });

    const fsOnlyRoot = await makeTempRoot();
    await fs.mkdir(path.join(fsOnlyRoot, "node_modules", "openclaw"), { recursive: true });
    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(fsOnlyRoot, { now: () => 456 })),
    ).resolves.toMatchObject({ status: "repaired" });
    await expect(
      inspectManagedNpmRootOpenClawPoison({ npmRoot: fsOnlyRoot }),
    ).resolves.toMatchObject({
      hasPoison: false,
    });
  });

  it("does not treat plugin-local openclaw peer links as root poison", async () => {
    const npmRoot = await makeTempRoot();
    await fs.mkdir(
      path.join(npmRoot, "node_modules", "@openclaw", "discord", "node_modules", "openclaw"),
      {
        recursive: true,
      },
    );

    await expect(inspectManagedNpmRootOpenClawPoison({ npmRoot })).resolves.toMatchObject({
      hasPoison: false,
    });
    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(npmRoot)),
    ).resolves.toMatchObject({ changed: false, status: "unchanged" });
  });

  it("refuses unsafe bare openclaw and pnpm workspace roots", async () => {
    const bareOpenClawRoot = await makeTempRoot();
    await writePoisonedRoot(bareOpenClawRoot);
    await fs.writeFile(
      path.join(bareOpenClawRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", dependencies: { openclaw: "2026.5.4" } }, null, 2)}\n`,
    );
    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(bareOpenClawRoot)),
    ).resolves.toMatchObject({ status: "skipped", reason: "root package is openclaw" });

    const workspaceRoot = await makeTempRoot();
    await writePoisonedRoot(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages: []\n");
    await expect(
      repairManagedNpmRootOpenClawPeer(createRepairParams(workspaceRoot)),
    ).resolves.toMatchObject({ status: "skipped", reason: "root is a pnpm workspace" });
  });

  it("requires legacy default path, install-record trust, or an existing marker", async () => {
    const customRoot = await makeTempRoot();
    await writePoisonedRoot(customRoot);
    await expect(
      repairManagedNpmRootOpenClawPeer(
        createRepairParams(customRoot, { defaultNpmRoot: path.join(customRoot, "other") }),
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "root is not a proven OpenClaw-managed npm root",
    });

    await expect(
      repairManagedNpmRootOpenClawPeer(
        createRepairParams(customRoot, {
          defaultNpmRoot: path.join(customRoot, "other"),
          trustedByInstallRecord: true,
        }),
      ),
    ).resolves.toMatchObject({ status: "repaired" });

    const markedRoot = await makeTempRoot();
    await writePoisonedRoot(markedRoot);
    const markedManifestPath = path.join(markedRoot, "package.json");
    const markedManifest = JSON.parse(await fs.readFile(markedManifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      markedManifestPath,
      `${JSON.stringify({ ...markedManifest, openclawManagedPluginRoot: true }, null, 2)}\n`,
    );

    await expect(
      repairManagedNpmRootOpenClawPeer(
        createRepairParams(markedRoot, { defaultNpmRoot: path.join(markedRoot, "other") }),
      ),
    ).resolves.toMatchObject({ status: "repaired" });
  });
});
