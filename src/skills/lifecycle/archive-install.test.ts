// Archive install tests cover archive validation, extraction, and install output.
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
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
  applyExtractedSkillRoot,
  installExtractedSkillRoot,
} from "./archive-install.js";
import { resolveWorkspaceSkillInstallDir } from "./install-paths.js";
import { digestClawHubSkillTree } from "./skill-tree-digest.js";

const tempDirs = createTrackedTempDirs();

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
  return [
    "---",
    `name: ${name}`,
    "description: Lifecycle test skill",
    `version: ${version}`,
    "---",
    "",
    "# Test",
    "",
  ].join("\n");
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
        expect(await fs.readFile(path.join(root, "host/skills/links/relative"), "utf8")).toBe(
          "contained asset",
        );
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
        rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
        onExtracted: async (extractedRoot) =>
          await installExtractedSkillRoot({
            workspaceDir,
            slug: `legacy-${marker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            extractedRoot,
            mode: "install",
            rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
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

  it("keeps flat-root non-SKILL.md legacy markers rejected by strict packed-root resolution", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    await expectFlatRootMarkerRejected({ marker: "skills.md", root });
  });

  it("keeps flat-root lowercase skill.md rejected by strict packed-root resolution on case-sensitive filesystems", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const caseSensitive = await isCaseSensitiveFileSystem(root);
    if (!caseSensitive) {
      expect(caseSensitive).toBe(false);
      return;
    }
    await expectFlatRootMarkerRejected({ marker: "skill.md", root });
  });

  it("keeps skill archive policy installs independent from built-in scanner blocks", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("ClawHub Policy"));
    await fs.writeFile(path.join(extractedRoot, "payload.js"), "eval('danger');\n");
    const handler = vi.fn().mockReturnValue({});
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "clawhub-policy-only",
      extractedRoot,
      mode: "install",
      policy: {
        config: {},
        installId: "clawhub",
        origin: { type: "clawhub", slug: "clawhub-policy-only", version: "1.0.0" },
        source: { kind: "clawhub", authority: "openclaw", mutable: false, network: true },
        requestedSpecifier: "clawhub:clawhub-policy-only@1.0.0",
      },
      rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as
      | { builtinScan?: { status?: string; scannedFiles?: number; findings?: unknown[] } }
      | undefined;
    expect(payload?.builtinScan).toMatchObject({
      status: "ok",
      scannedFiles: 0,
      findings: [],
    });
  });

  it("keeps legacy skill-upload origin for before_install hooks", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Uploaded Policy"));
    const handler = vi.fn().mockReturnValue({});
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "uploaded-policy",
      extractedRoot,
      mode: "install",
      policy: {
        config: {},
        installId: "upload",
        origin: { type: "upload", uploadId: "upload-123", sha256: "0".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-123",
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as { origin?: string } | undefined;
    const ctx = handler.mock.calls[0]?.[1] as { origin?: string } | undefined;
    expect(payload?.origin).toBe("skill-upload");
    expect(ctx?.origin).toBe("skill-upload");
  });

  it("reports forced installs of missing skills as install mode to policy", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Forced Missing"));
    const handler = vi.fn((payload: unknown) => {
      const event = payload as { request?: { mode?: string } };
      if (event.request?.mode === "install") {
        return { block: true, blockReason: "fresh skill installs are disabled by policy" };
      }
      return {};
    });
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "before_install", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "forced-missing",
      extractedRoot,
      mode: "update",
      policy: {
        config: {},
        installId: "archive",
        origin: { type: "upload", uploadId: "upload-456", sha256: "1".repeat(64) },
        source: { kind: "upload", authority: "user", mutable: false, network: false },
        requestedSpecifier: "upload:upload-456",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("fresh skill installs are disabled by policy");
    }
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]?.[0] as { request?: { mode?: string } } | undefined;
    expect(payload?.request?.mode).toBe("install");
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
        expect(await fs.readFile(path.join(staleDir, "SKILL.md"), "utf8")).toBe(
          "stale Gateway file",
        );
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
          expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toContain(
            "Host Skill",
          );
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
      const root = await tempDirs.make("openclaw-skill-update-state-");
      const workspaceDir = path.join(root, "workspace");
      const extractedRoot = path.join(root, "extracted");
      await fs.mkdir(extractedRoot, { recursive: true });
      await fs.writeFile(path.join(extractedRoot, "SKILL.md"), "replacement");
      const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "weather");
      if (state !== "absent") {
        await fs.mkdir(targetDir, { recursive: true });
        await fs.writeFile(path.join(targetDir, "SKILL.md"), "original");
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
      const result = await installExtractedSkillRoot({
        workspaceDir,
        slug: "weather",
        extractedRoot,
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
      expect(await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).toBe(
        state === "appeared" ? "original" : "replacement",
      );
    },
  );

  it("restores a skill when backup validation blocks replacement", async () => {
    const root = await tempDirs.make("openclaw-skill-archive-install-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Staged Update"));
    const targetDir = resolveWorkspaceSkillInstallDir(workspaceDir, "staged-update");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "SKILL.md"), skillFileContent("Installed Skill"));
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
      rootMarkers: CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS,
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
    await expect(fs.readFile(path.join(targetDir, "notes.md"), "utf8")).resolves.toBe(
      "edited before backup",
    );
    await expect(fs.readFile(path.join(targetDir, "SKILL.md"), "utf8")).resolves.toContain(
      "Installed Skill",
    );
    await expect(
      fs.readdir(path.join(skillsDir, ".openclaw-install-backups")),
    ).resolves.toHaveLength(0);
  });

  it.each([
    {
      label: "ClawHub",
      origin: { type: "clawhub", slug: "hook-clawhub", version: "1.2.3" },
      expectedSource: "clawhub",
      expectedSourceVersion: "1.2.3",
    },
    {
      label: "upload",
      origin: { type: "upload", uploadId: "upload-123", sha256: "0".repeat(64) },
      expectedSource: "upload",
      expectedSourceVersion: undefined,
    },
    {
      label: "path",
      origin: { type: "path", spec: "./skill" },
      expectedSource: "source-install",
      expectedSourceVersion: undefined,
    },
  ] as const)("attributes committed $label archive installs", async (testCase) => {
    const root = await tempDirs.make("openclaw-skill-change-create-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("Hook Create", "4.5.6"),
    );
    await fs.writeFile(path.join(extractedRoot, "binary.bin"), Buffer.from([0, 255, 1, 254]));
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-create",
      extractedRoot,
      mode: "install",
      policy: {
        origin: testCase.origin,
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
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

  it("emits before and after artifacts for committed updates", async () => {
    const root = await tempDirs.make("openclaw-skill-change-update-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("Before Update", "1.0.0"),
    );
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));
    await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-update",
      extractedRoot,
      mode: "install",
      policy: { origin: { type: "path", spec: "./skill" } },
    });
    handler.mockClear();
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      versionedSkillFileContent("After Update", "2.0.0"),
    );
    await fs.writeFile(path.join(extractedRoot, "payload.bin"), Buffer.from([0, 128, 255]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-update",
      extractedRoot,
      mode: "update",
      policy: {
        origin: { type: "git", spec: "git:https://example.test/skill.git", commit: "abc123" },
      },
    });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as {
      action: string;
      source: string;
      before: { name: string; revision: { contentSha256: string; treeSha256: string } };
      after: {
        name: string;
        revision: { contentSha256: string; treeSha256: string; sourceVersion?: string };
      };
    };
    expect(event).toMatchObject({
      action: "updated",
      source: "source-install",
      before: { name: "Before Update" },
      after: {
        name: "After Update",
        revision: { sourceVersion: "abc123" },
      },
    });
    expect(event.before.revision.contentSha256).not.toBe(event.after.revision.contentSha256);
    expect(event.before.revision.treeSha256).not.toBe(event.after.revision.treeSha256);
  });

  it("does not emit when an archive mutation fails", async () => {
    const root = await tempDirs.make("openclaw-skill-change-failure-");
    const workspaceDir = path.join(root, "workspace");
    const extractedRoot = path.join(root, "extracted");
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(path.join(extractedRoot, "SKILL.md"), skillFileContent("Failure"));
    await fs.mkdir(path.join(workspaceDir, "skills", "hook-failure"), { recursive: true });
    const handler = vi.fn();
    initializeGlobalHookRunner(createMockPluginRegistry([{ hookName: "skill_changed", handler }]));

    const result = await installExtractedSkillRoot({
      workspaceDir,
      slug: "hook-failure",
      extractedRoot,
      mode: "install",
      policy: { origin: { type: "upload" } },
    });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
