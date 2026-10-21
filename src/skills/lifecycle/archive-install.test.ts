import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteShellSandboxSession } from "../../agents/sandbox/remote-shell-transport.js";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookSkillChangedEvent } from "../../plugins/hook-types.js";
import { addTestHook, createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS as clawHubMarkers,
  applyExtractedSkillRoot,
  installExtractedSkillRoot,
} from "./archive-install.js";
import { resolveWorkspaceSkillInstallDir } from "./install-paths.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = createTrackedTempDirs();
const read = (dir: string, name = "SKILL.md") => fs.readFile(path.join(dir, name), "utf8");

async function writeZipArchive(params: {
  archivePath: string;
  entries: Record<string, string>;
}): Promise<void> {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(params.entries)) {
    zip.file(entryPath, content);
  }
  await fs.writeFile(
    params.archivePath,
    Buffer.from(await zip.generateAsync({ type: "nodebuffer" })),
  );
}

async function isCaseSensitiveFileSystem(root: string): Promise<boolean> {
  const marker = path.join(root, "case-check");
  await fs.writeFile(marker, "case", "utf8");
  const upperExists = await fs
    .stat(path.join(root, "CASE-CHECK"))
    .then(() => true)
    .catch(() => false);
  return !upperExists;
}

async function expectFlatRootMarkerRejected(params: {
  marker: string;
  root: string;
}): Promise<void> {
  const archivePath = path.join(params.root, `flat-${params.marker}.zip`);
  await writeZipArchive({
    archivePath,
    entries: {
      [params.marker]: skillFileContent("Flat Legacy Marker"),
    },
  });

  const result = await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-skill-clawhub-test-",
    timeoutMs: 120_000,
    rootMarkers: ["SKILL.md"],
    onExtracted: async () => ({ ok: true as const }),
  });

  expect(result).toEqual({
    ok: false,
    error: "Error: unexpected archive layout (dirs: )",
  });
}

function skillFileContent(name: string): string {
  return ["---", `name: ${name}`, "description: Test skill", "---", "", "# Test", ""].join("\n");
}

function versionedSkillFileContent(name: string, version: string): string {
  return `---\nname: ${name}\ndescription: Lifecycle test skill\nversion: ${version}\n---\n\n# Test\n`;
}

async function writeSkill(dir: string, content: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), content);
}

async function fixture(content: string) {
  const root = await tempDirs.make("openclaw-skill-archive-");
  const workspaceDir = path.join(root, "workspace");
  const extractedRoot = path.join(root, "extracted");
  await writeSkill(extractedRoot, content);
  const install = (
    slug: string,
    options: Omit<
      Parameters<typeof installExtractedSkillRoot>[0],
      "workspaceDir" | "extractedRoot" | "slug" | "mode"
    > & { mode?: "install" | "update" } = {},
  ) =>
    installExtractedSkillRoot({ workspaceDir, extractedRoot, slug, mode: "install", ...options });
  return { root, workspaceDir, extractedRoot, install };
}

afterEach(async () => {
  resetGlobalHookRunner();
  await tempDirs.cleanup();
});

describe("skill archive install", () => {
  it.runIf(process.platform !== "win32")(
    "preserves native local links and confines remote upload links",
    async () => {
      const root = await fs.realpath(await tempDirs.make("openclaw-skill-links-"));
      const source = path.join(root, "source");
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "SKILL.md"), "native links");
      const links = {
        absolute: "/opt/shared-assets",
        relative: "../shared-assets",
        dangling: "missing",
      };
      for (const [name, target] of Object.entries(links)) {
        await fs.symlink(target, path.join(source, name));
      }
      const local = await applyExtractedSkillRoot({
        workspaceDir: path.join(root, "local"),
        slug: "links",
        extractedRoot: source,
        mode: "install",
      });
      expect(local.ok).toBe(true);
      for (const [name, target] of Object.entries(links)) {
        expect(await fs.readlink(path.join(root, "local/skills/links", name))).toBe(target);
      }
      const session = createRemoteShellSandboxSession({
        buildCommand: ({ remoteCommand }) => ({
          argv: ["/bin/sh", "-c", remoteCommand],
          env: process.env,
        }),
      });
      const uploaded = path.join(root, "uploaded");
      try {
        await expect(
          session.uploadDirectory({ localDir: source, remoteDir: uploaded, remoteRootDir: root }),
        ).rejects.toThrow("refuses symlink");
        for (const name of Object.keys(links)) {
          await fs.unlink(path.join(source, name));
        }
        await fs.writeFile(path.join(source, "asset.txt"), "contained asset");
        await fs.symlink("asset.txt", path.join(source, "relative"));
        await session.uploadDirectory({
          localDir: source,
          remoteDir: uploaded,
          remoteRootDir: root,
        });
        const remote = await applyExtractedSkillRoot({
          workspaceDir: path.join(root, "host"),
          slug: "links",
          extractedRoot: uploaded,
          mode: "install",
        });
        expect(remote.ok).toBe(true);
        expect(await fs.readlink(path.join(root, "host/skills/links/relative"))).toBe("asset.txt");
        expect(await read(root, "host/skills/links/relative")).toBe("contained asset");
      } finally {
        await session.dispose();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "installs a streamed native tree without Skill Library import limits",
    async () => {
      const root = await fs.realpath(await tempDirs.make("openclaw-skill-native-apply-"));
      const extractedRoot = path.join(root, "extracted");
      const assetsDir = path.join(extractedRoot, "assets");
      await fs.mkdir(path.join(extractedRoot, "empty"), { recursive: true });
      await fs.mkdir(assetsDir);
      await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Native Tree"));
      const binary = Buffer.alloc(9 * 1024 * 1024, 0xa5);
      await fs.writeFile(path.join(extractedRoot, "model.bin"), binary);
      const names = Array.from({ length: 257 }, (_, index) => `asset-${index}.txt`);
      await Promise.all(names.map((name) => fs.writeFile(path.join(assetsDir, name), name)));

      const remoteDir = path.join(root, "received");
      const transport = createRemoteShellSandboxSession({
        buildCommand: ({ remoteCommand }) => ({
          argv: ["/bin/sh", "-c", remoteCommand],
          env: { PATH: process.env.PATH },
        }),
      });
      try {
        await transport.uploadDirectory({
          localDir: extractedRoot,
          remoteDir,
          remoteRootDir: root,
        });
      } finally {
        await transport.dispose();
      }
      // Installation must use the delivered tree, not accidentally read the sender's copy.
      await fs.rm(extractedRoot, { recursive: true });
      const result = await applyExtractedSkillRoot({
        workspaceDir: path.join(root, "workspace"),
        slug: "native-tree",
        extractedRoot: remoteDir,
        mode: "install",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(await fs.readdir(path.join(result.targetDir, "assets"))).toHaveLength(names.length);
      for (const name of names) {
        expect(await fs.readFile(path.join(result.targetDir, "assets", name), "utf8")).toBe(name);
      }
      expect(await fs.readdir(path.join(result.targetDir, "empty"))).toEqual([]);
      expect((await fs.readFile(path.join(result.targetDir, "model.bin"))).equals(binary)).toBe(
        true,
      );
    },
  );

  it.each(["skill.md", "skills.md", "SKILL.MD"])(
    "installs a single-root ClawHub archive with legacy marker %s",
    async (marker) => {
      const root = await tempDirs.make("openclaw-skill-archive-install-");
      const archivePath = path.join(root, "legacy.zip");
      const workspaceDir = path.join(root, "workspace");
      await writeZipArchive({
        archivePath,
        entries: {
          [`mydir/${marker}`]: skillFileContent("Legacy Marker"),
        },
      });

      const result = await withExtractedArchiveRoot({
        archivePath,
        tempDirPrefix: "openclaw-skill-clawhub-test-",
        timeoutMs: 120_000,
        rootMarkers: clawHubMarkers,
        onExtracted: async (extractedRoot) =>
          await installExtractedSkillRoot({
            workspaceDir,
            slug: `legacy-${marker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            extractedRoot,
            mode: "install",
            rootMarkers: clawHubMarkers,
          }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      await expect(fs.readFile(path.join(result.targetDir, marker), "utf8")).resolves.toContain(
        "Legacy Marker",
      );
    },
  );

  it.each(["skills.md", "skill.md"])(
    "rejects flat-root %s with strict packed-root resolution",
    async (marker) => {
      const root = await tempDirs.make("openclaw-skill-archive-install-");
      if (marker === "skill.md") {
        const caseSensitive = await isCaseSensitiveFileSystem(root);
        if (!caseSensitive) {
          expect(caseSensitive).toBe(false);
          return;
        }
      }
      await expectFlatRootMarkerRejected({ marker, root });
    },
  );

  it.each([
    {
      label: "ClawHub",
      mode: "install",
      policy: {
        config: {},
        installId: "clawhub",
        origin: { type: "clawhub", slug: "hook-clawhub", version: "1.2.3" },
        source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
        requestedSpecifier: "clawhub:hook-clawhub@1.2.3",
      },
      expectedSource: "clawhub",
      expectedSourceVersion: "1.2.3",
    },
    {
      label: "upload",
      mode: "install",
      policy: {
        config: {},
        installId: "upload",
        origin: { type: "upload", uploadId: "upload-123", sha256: "0".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-123",
      },
      expectedSource: "upload",
      expectedSourceVersion: undefined,
    },
    {
      label: "path",
      mode: "install",
      policy: { origin: { type: "path", spec: "./skill" } },
      expectedSource: "source-install",
      expectedSourceVersion: undefined,
    },
    {
      label: "forced missing",
      mode: "update",
      policy: {
        config: {},
        installId: "archive",
        origin: { type: "upload", uploadId: "upload-456", sha256: "1".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-456",
      },
      expectedSource: "upload",
      expectedSourceVersion: undefined,
    },
  ] as const)("applies $label policy before attributing a committed install", async (testCase) => {
    const { extractedRoot, install } = await fixture(
      versionedSkillFileContent("Hook Create", "4.5.6"),
    );
    await fs.writeFile(path.join(extractedRoot, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    if (testCase.label === "ClawHub") {
      await fs.writeFile(path.join(extractedRoot, "payload.js"), "eval('danger');\n");
    }
    const handler = vi.fn((payload: unknown, _context?: unknown) => {
      const event = payload as { request?: { mode?: string } };
      if (testCase.mode === "update" && event.request?.mode === "install") {
        return { block: true, blockReason: "fresh skill installs are disabled by policy" };
      }
      return {};
    });
    const committed = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_install", handler },
        { hookName: "skill_changed", handler: committed },
      ]),
    );

    const result = await install("hook-create", {
      mode: testCase.mode,
      policy: testCase.policy,
      ...(testCase.label === "ClawHub" ? { rootMarkers: clawHubMarkers } : {}),
    });
    expect(handler).toHaveBeenCalledTimes(1);
    if (testCase.mode === "update") {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("fresh skill installs are disabled by policy");
      }
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ request: { mode: "install" } });
      expect(committed).not.toHaveBeenCalled();
      return;
    }
    expect(result.ok).toBe(true);
    if (testCase.label === "ClawHub") {
      expect(handler.mock.calls[0]?.[0]).toMatchObject({
        builtinScan: { status: "ok", scannedFiles: 0, findings: [] },
      });
    } else if (testCase.label === "upload") {
      expect(handler.mock.calls[0]?.[0]).toMatchObject({ origin: "skill-upload" });
      expect(handler.mock.calls[0]?.[1]).toMatchObject({ origin: "skill-upload" });
    }
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.calls[0]?.[0]).toMatchObject({
      action: "created",
      source: testCase.expectedSource,
      after: {
        name: "Hook Create",
        skillKey: "hook-create",
        description: "Lifecycle test skill",
        source: testCase.expectedSource,
        revision: {
          declaredVersion: "4.5.6",
          contentSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          treeSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ...(testCase.expectedSourceVersion
            ? { sourceVersion: testCase.expectedSourceVersion }
            : {}),
        },
      },
    });
  });

  it.each([false, true])(
    "keeps Gateway policy and host installation separate (blocked=%s)",
    async (blocked) => {
      const root = await tempDirs.make("openclaw-skill-host-install-");
      const workspaceDir = path.join(root, "gateway");
      const hostWorkspace = path.join(root, "host");
      const extractedRoot = path.join(root, "source");
      await fs.mkdir(extractedRoot, { recursive: true });
      await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Host Skill"));
      // A stale Gateway directory must not decide install/update mode or receive the replacement.
      const staleDir = resolveWorkspaceSkillInstallDir(workspaceDir, "host-skill");
      await fs.mkdir(staleDir, { recursive: true });
      await fs.writeFile(path.join(staleDir, "SKILL.md"), "stale Gateway file");
      const handler = vi.fn((_payload: unknown) =>
        blocked ? { block: true, blockReason: "blocked on Gateway" } : {},
      );
      const committed = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_install", handler },
          { hookName: "skill_changed", handler: committed },
        ]),
      );
      const applySkillRoot: NonNullable<AgentWorkspaceAccess["applySkillRoot"]> = async (
        request,
      ) => {
        expect(request).not.toHaveProperty("policy");
        // Local host fixture exercises the native owner; it is not a network transport test.
        return await applyExtractedSkillRoot({ ...request, workspaceDir: hostWorkspace });
      };
      const unavailable = async (): Promise<never> => {
        throw new Error("file bridge must not install Skills");
      };
      const release = registerAgentWorkspaceAccess(workspaceDir, {
        loadSkills: vi.fn(),
        applySkillRoot,
        bridge: { readFile: unavailable, writeFile: unavailable, stat: unavailable },
      });
      try {
        const result = await installExtractedSkillRoot({
          workspaceDir,
          slug: "host-skill",
          extractedRoot,
          mode: "update",
          policy: {
            config: {},
            installId: "archive",
            origin: { type: "upload", uploadId: "host-install", sha256: "1".repeat(64) },
            source: { kind: "upload", authority: "user", mutable: false, network: false },
          },
        });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({ request: { mode: "install" } });
        expect(await read(staleDir)).toBe("stale Gateway file");
        const targetDir = resolveWorkspaceSkillInstallDir(hostWorkspace, "host-skill");
        if (blocked) {
          expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining("blocked on Gateway"),
          });
          await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
          expect(committed).not.toHaveBeenCalled();
        } else {
          expect(result).toEqual({ ok: true, targetDir });
          expect(await read(targetDir)).toContain("Host Skill");
          expect(committed).toHaveBeenCalledTimes(1);
          expect(committed.mock.calls[0]?.[0]).toMatchObject({ action: "created" });
          expect(committed.mock.calls[0]?.[1]).toEqual({ workspaceDir });
        }
      } finally {
        release();
      }
    },
  );

  it.each(["unchanged", "absent", "appeared", "force"] as const)(
    "preserves native replacement behavior when the installed skill is %s",
    async (state) => {
      const { workspaceDir, install } = await fixture("replacement");
      const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "weather");
      if (state !== "absent") {
        await writeSkill(targetDir, "original");
      }
      const expectedClawHubState =
        state === "unchanged"
          ? {
              slug: "weather",
              skillFilePath: "SKILL.md",
              skillFileSha256: sha256Hex("original"),
              fileTreeSha256: await digestClawHubSkillTree(targetDir),
            }
          : state === "force"
            ? undefined
            : null;
      const result = await install("weather", {
        mode: "update",
        expectedClawHubState,
      });
      if (state === "appeared") {
        expect(result).toMatchObject({
          ok: false,
          failureKind: "invalid-request",
          replacementBlocked:
            'Skill "weather" appeared during update. Updating replaces the installed skill directory.',
        });
      } else {
        expect(result).toEqual({ ok: true, targetDir });
      }
      expect(await read(targetDir)).toBe(state === "appeared" ? "original" : "replacement");
    },
  );

  it("restores a skill when backup validation blocks replacement", async () => {
    const { workspaceDir, extractedRoot } = await fixture(skillFileContent("Staged Update"));
    const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "staged-update");
    await writeSkill(targetDir, skillFileContent("Installed Skill"));
    const skillsDir = path.dirname(targetDir);
    const expectedClawHubState = {
      slug: "staged-update",
      skillFilePath: "SKILL.md",
      skillFileSha256: sha256Hex(await fs.readFile(path.join(targetDir, "SKILL.md"))),
      fileTreeSha256: await digestClawHubSkillTree(targetDir),
    };

    const result = await applyExtractedSkillRoot({
      workspaceDir,
      slug: "staged-update",
      extractedRoot,
      mode: "update",
      rootMarkers: clawHubMarkers,
      expectedClawHubState,
      beforeInstall: async () => {
        await fs.writeFile(path.join(targetDir, "notes.md"), "edited before backup", "utf8");
        return undefined;
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error:
        'Skill "staged-update" changed during update. Updating replaces the installed skill directory.',
      replacementBlocked:
        'Skill "staged-update" changed during update. Updating replaces the installed skill directory.',
      failureKind: "invalid-request",
    });
    await expect(read(targetDir, "notes.md")).resolves.toBe("edited before backup");
    await expect(read(targetDir)).resolves.toContain("Installed Skill");
    await expect(
      fs.readdir(path.join(skillsDir, ".openclaw-install-backups")),
    ).resolves.toHaveLength(0);
  });

  it.each(["update", "install"] as const)(
    "emits artifacts only when %s of an existing skill commits",
    async (mode) => {
      const { workspaceDir, extractedRoot, install } = await fixture(
        versionedSkillFileContent("Before Update", "1.0.0"),
      );
      const handler = vi.fn<(event: PluginHookSkillChangedEvent) => void>();
      const registry = createMockPluginRegistry([]);
      addTestHook({ registry, pluginId: "test-plugin", hookName: "skill_changed", handler });
      initializeGlobalHookRunner(registry);
      if (mode === "update") {
        await install("hook-update", {
          mode: "install",
          policy: { origin: { type: "path", spec: "./skill" } },
        });
        handler.mockClear();
      } else {
        await fs.mkdir(path.join(workspaceDir, "skills", "hook-update"), { recursive: true });
      }
      await fs.writeFile(
        path.join(extractedRoot, "SKILL.md"),
        versionedSkillFileContent("After Update", "2.0.0"),
      );
      await fs.writeFile(path.join(extractedRoot, "payload.bin"), Buffer.from([0, 128, 255]));

      const result = await install("hook-update", {
        mode,
        policy: {
          origin:
            mode === "update"
              ? { type: "git", spec: "git:https://example.test/skill.git", commit: "abc123" }
              : { type: "upload" },
        },
      });

      if (mode === "install") {
        expect(result.ok).toBe(false);
        expect(handler).not.toHaveBeenCalled();
        return;
      }
      expect(result.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]![0];
      expect(event).toMatchObject({
        action: "updated",
        source: "source-install",
        before: { name: "Before Update" },
        after: {
          name: "After Update",
          revision: { sourceVersion: "abc123" },
        },
      });
      expect(event.before!.revision.contentSha256).not.toBe(event.after!.revision.contentSha256);
      expect(event.before!.revision.treeSha256).not.toBe(event.after!.revision.treeSha256);
    },
  );

  it.each(["before apply", "after target check"] as const)(
    "refuses a guarded deferred update when the old skill disappears %s",
    async (when) => {
      const { workspaceDir, extractedRoot } = await fixture("new skill");
      const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "weather");
      await writeSkill(targetDir, "old skill");
      const expectedClawHubState = {
        slug: "weather",
        skillFilePath: "SKILL.md",
        skillFileSha256: sha256Hex("old skill"),
        fileTreeSha256: await digestClawHubSkillTree(targetDir),
      };
      if (when === "before apply") {
        await fs.rm(targetDir, { recursive: true });
      }

      const result = await applyExtractedSkillRoot({
        workspaceDir,
        slug: "weather",
        extractedRoot,
        mode: "update",
        expectedClawHubState,
        deferCommit: true,
        assertOwned: () => undefined,
        beforeInstall: async () => {
          if (when === "after target check") {
            await fs.rm(targetDir, { recursive: true });
          }
          return undefined;
        },
      });

      expect(result).toMatchObject({ ok: false });
      await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("emits a deferred update hook only after the owning transaction commits", async () => {
    const { extractedRoot, install } = await fixture(
      versionedSkillFileContent("Before Update", "1.0.0"),
    );
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
    await install("hook-update", {
      mode: "install",
      policy: { origin: { type: "path", spec: "./skill" } },
    });
    handler.mockClear();
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("After Update", "2.0.0"),
    );

    const defer = () =>
      install("hook-update", {
        mode: "update",
        deferCommit: true,
        assertOwned: () => undefined,
        policy: { origin: { type: "path", spec: "./skill" } },
      });
    const rolledBack = await defer();
    expect(rolledBack.ok).toBe(true);
    if (!rolledBack.ok || !rolledBack.transaction) {
      throw new Error("expected deferred skill transaction");
    }
    expect(handler).not.toHaveBeenCalled();
    await rolledBack.transaction.rollback();
    expect(handler).not.toHaveBeenCalled();

    const committed = await defer();
    expect(committed.ok).toBe(true);
    if (!committed.ok || !committed.transaction) {
      throw new Error("expected deferred skill transaction");
    }
    expect(handler).not.toHaveBeenCalled();
    await committed.transaction.commit();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ action: "updated" });
  });

  it("refuses a deferred replacement without a live owner guard", async () => {
    const root = await tempDirs.make("openclaw-skill-deferred-owner-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    const targetDir = path.join(workspaceDir, "skills", "guarded");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(targetDir, "SKILL.md"), skillFileContent("Before"));
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("After"));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "guarded",
      extractedRoot,
      mode: "update",
      deferCommit: true,
      policy: { origin: { type: "path", spec: "./skill" } },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Deferred skill replacement requires a live owner guard.",
    });
    expect(await read(targetDir)).toBe(skillFileContent("Before"));
  });
});
