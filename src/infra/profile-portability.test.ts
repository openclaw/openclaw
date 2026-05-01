import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  buildSafeProfileConfig,
  createProfileArchive,
  importProfileArchive,
} from "./profile-portability.js";

async function readArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

async function readArchiveManifest(archivePath: string): Promise<{
  configPaths: string[];
  assets: Array<{ kind: string; archivePath: string; relativePath?: string }>;
}> {
  const manifest = await readArchiveEntry(archivePath, "/manifest.json");
  return JSON.parse(manifest) as {
    configPaths: string[];
    assets: Array<{ kind: string; archivePath: string; relativePath?: string }>;
  };
}

async function readArchiveEntry(archivePath: string, entrySuffix: string): Promise<string> {
  let manifest = "";
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      if (!entry.path.endsWith(entrySuffix)) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      entry.on("end", () => {
        manifest = Buffer.concat(chunks).toString("utf8");
      });
    },
  });
  return manifest;
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeProfileArchiveFixture(
  archivePath: string,
  entries: Record<string, string>,
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-archive-"));
  try {
    for (const [entryPath, contents] of Object.entries(entries)) {
      const filePath = path.join(tempDir, ...entryPath.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    }
    await tar.c(
      {
        cwd: tempDir,
        file: archivePath,
        gzip: true,
        portable: true,
      },
      Object.keys(entries),
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("profile portability", () => {
  let tempHomes: TempHomeEnv[] = [];

  async function createHome(prefix: string): Promise<TempHomeEnv> {
    const env = await createTempHomeEnv(prefix);
    tempHomes.push(env);
    resetConfigRuntimeState();
    return env;
  }

  afterEach(async () => {
    resetConfigRuntimeState();
    for (const tempHome of tempHomes.toReversed()) {
      await tempHome.restore();
    }
    tempHomes = [];
  });

  it("exports only privacy-safe profile config and workspace files", async () => {
    const tempHome = await createHome("openclaw-profile-export-");
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-out-"));
    try {
      await writeJson(path.join(stateDir, "openclaw.json"), {
        env: { vars: { OPENAI_API_KEY: "secret" } },
        gateway: { auth: { token: "secret-token-value" } },
        ui: {
          assistant: {
            name: "Portable",
          },
        },
        agents: {
          defaults: {
            workspace: workspaceDir,
            repoRoot: "/tmp/local-repo",
            model: "openai/gpt-5.4",
          },
          list: [
            {
              id: "main",
              workspace: workspaceDir,
              agentDir: path.join(stateDir, "agents", "main", "agent"),
              name: "Main",
            },
          ],
        },
        plugins: {
          slots: { memory: "memory-core" },
          entries: { "memory-core": { enabled: true } },
        },
        skills: {
          entries: {
            "web-skill": {
              enabled: true,
              config: {
                mode: "portable",
                privateKey: "skill-config-private-key",
                encryptKey: "skill-config-encrypt-key",
                encryption_key: "skill-config-encryption-key",
              },
            },
          },
        },
        memory: { backend: "qmd" },
      });
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "# agents\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# memory\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "memory", "2026-04-28.md"), "daily\n", "utf8");
      await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "agents", "main", "sessions", "s.jsonl"), "{}\n");
      await fs.mkdir(path.join(stateDir, "media"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "media", "image.png"), "not-exported");
      await writeJson(path.join(stateDir, "plugins", "installs.json"), {
        plugins: [
          {
            pluginId: "memory-core",
            manifestPath: path.join(stateDir, "plugins", "cache", "memory-core", "plugin.json"),
            rootDir: path.join(stateDir, "plugins", "cache", "memory-core"),
          },
        ],
        installRecords: {
          "memory-core": {
            source: "npm",
            spec: "memory-core",
            sourcePath: path.join(stateDir, "plugins", "sources", "memory-core"),
            installPath: path.join(stateDir, "plugins", "cache", "memory-core"),
            installedAt: "2026-04-28T00:00:00.000Z",
            privateKey: "plugin-install-private-key",
            encryptKey: "plugin-install-encrypt-key",
          },
          "local-only": {
            source: "path",
            spec: path.join(tempHome.home, "private-plugin"),
            sourcePath: path.join(tempHome.home, "private-plugin"),
            installPath: path.join(stateDir, "plugins", "cache", "local-only"),
          },
        },
      });
      await writeJson(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), {
        version: 1,
        profiles: { secret: { type: "api_key", key: "secret" } },
      });

      const result = await createProfileArchive({
        output: outputDir,
        verify: true,
        nowMs: Date.UTC(2026, 3, 28),
      });

      expect(result.verified).toBe(true);
      expect(result.workspaceFiles.map((file) => file.relativePath)).toEqual(
        expect.arrayContaining(["AGENTS.md", "MEMORY.md", "memory/2026-04-28.md"]),
      );
      const entries = await readArchiveEntries(result.archivePath);
      const joinedEntries = entries.join("\n");
      expect(joinedEntries).toContain("payload/config/openclaw.json");
      expect(joinedEntries).toContain("payload/plugins/installs.json");
      expect(joinedEntries).toContain("payload/workspaces/main/AGENTS.md");
      expect(joinedEntries).not.toContain("auth-profiles.json");
      expect(joinedEntries).not.toContain("sessions");
      expect(joinedEntries).not.toContain("media");

      const manifest = await readArchiveManifest(result.archivePath);
      expect(manifest.configPaths).toEqual(
        expect.arrayContaining(["ui", "agents", "plugins.entries", "plugins.slots", "memory"]),
      );
      const configAsset = manifest.assets.find((asset) => asset.kind === "config");
      expect(configAsset?.archivePath).toContain("payload/config/openclaw.json");
      const configPayloadRaw = await readArchiveEntry(
        result.archivePath,
        "/payload/config/openclaw.json",
      );
      expect(configPayloadRaw).not.toContain("skill-config-private-key");
      expect(configPayloadRaw).not.toContain("skill-config-encrypt-key");
      expect(configPayloadRaw).not.toContain("skill-config-encryption-key");
      expect(configPayloadRaw).not.toContain("privateKey");
      expect(configPayloadRaw).not.toContain("encryptKey");
      expect(configPayloadRaw).not.toContain("encryption_key");
      const pluginPayloadRaw = await readArchiveEntry(
        result.archivePath,
        "/payload/plugins/installs.json",
      );
      expect(pluginPayloadRaw).not.toContain(tempHome.home);
      expect(pluginPayloadRaw).not.toContain("sourcePath");
      expect(pluginPayloadRaw).not.toContain("installPath");
      expect(pluginPayloadRaw).not.toContain("installedAt");
      expect(pluginPayloadRaw).not.toContain("manifestPath");
      expect(pluginPayloadRaw).not.toContain("rootDir");
      expect(pluginPayloadRaw).not.toContain("plugin-install-private-key");
      expect(pluginPayloadRaw).not.toContain("plugin-install-encrypt-key");
      expect(pluginPayloadRaw).not.toContain("privateKey");
      expect(pluginPayloadRaw).not.toContain("encryptKey");
      const pluginPayload = JSON.parse(pluginPayloadRaw) as {
        schemaVersion: number;
        archiveKind: string;
        records: Record<string, unknown>;
        plugins?: unknown;
      };
      expect(pluginPayload).toMatchObject({
        schemaVersion: 1,
        archiveKind: "openclaw-profile",
        records: { "memory-core": { source: "npm", spec: "memory-core" } },
      });
      expect(pluginPayload.records["local-only"]).toBeUndefined();
      expect(pluginPayload.plugins).toBeUndefined();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("strips nested secrets and local paths from profile config projections", () => {
    const safeConfig = buildSafeProfileConfig({
      agents: {
        defaults: {
          workspace: "/tmp/local-workspace",
          repoRoot: "/tmp/local-repo",
          cliBackends: {
            custom: {
              command: "custom-agent",
              env: { OPENAI_API_KEY: "agent-secret-env" },
              privateKey: "agent-private-key",
            },
            servers: {
              command: "colliding-agent",
              env: { OPENAI_API_KEY: "agent-collision-secret-env" },
              encryptKey: "agent-encrypt-key",
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/local-workspace",
            agentDir: "/tmp/local-agent",
            runtime: { type: "acp", acp: { cwd: "/tmp/local-acp", backend: "codex" } },
          },
        ],
      },
      plugins: {
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": {
            enabled: true,
            config: {
              mode: "portable",
              token: "plugin-secret-token",
              privateKey: "plugin-private-key",
              encryptKey: "plugin-encrypt-key",
            },
          },
          servers: {
            enabled: true,
            config: {
              mode: "collision",
              token: "plugin-collision-secret-token",
              encryptionKey: "plugin-collision-encryption-key",
            },
          },
        },
      },
      skills: {
        load: { extraDirs: ["/tmp/local-skills"] },
        entries: {
          "web-skill": {
            enabled: true,
            apiKey: "skill-secret-key",
            privateKey: "skill-private-key",
            env: { OPENAI_API_KEY: "skill-secret-env" },
            config: {
              mode: "portable",
              token: "skill-secret-token",
              encryptKey: "skill-encrypt-key",
            },
          },
          servers: {
            enabled: true,
            env: { OPENAI_API_KEY: "skill-collision-secret-env" },
            config: {
              mode: "collision",
              token: "skill-collision-secret-token",
              private_key: "skill-collision-private-key",
            },
          },
        },
      },
      tools: {
        media: {
          image: {
            models: [
              {
                provider: "openai",
                model: "gpt-image",
                headers: { Authorization: "Bearer tool-secret-token" },
                privateKey: "tool-private-key",
              },
            ],
          },
        },
      },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
          encryptKey: "memory-encrypt-key",
          paths: [{ path: "/tmp/private-memory", name: "private" }],
          sessions: { exportDir: "/tmp/session-memory", retentionDays: 7 },
        },
      },
      mcp: {
        servers: {
          auth: {
            command: "node",
            args: ["server.js"],
            env: { MCP_API_KEY: "mcp-secret-env" },
            headers: { Authorization: "Bearer mcp-secret-token" },
            privateKey: "mcp-private-key",
            encryptKey: "mcp-encrypt-key",
            cwd: "/tmp/local-mcp",
            url: "https://mcp.example.test",
          },
          entries: {
            command: "node",
            env: { MCP_API_KEY: "mcp-collision-secret-env" },
            headers: { Authorization: "Bearer mcp-collision-secret-token" },
            privateKey: "mcp-collision-private-key",
            url: "https://mcp-collision.example.test",
          },
        },
      },
    } as unknown as OpenClawConfig);
    const serialized = JSON.stringify(safeConfig);

    expect(safeConfig.plugins?.entries?.["memory-core"]?.config).toEqual({ mode: "portable" });
    expect(safeConfig.plugins?.entries?.servers?.config).toEqual({ mode: "collision" });
    expect(safeConfig.skills?.entries?.["web-skill"]?.config).toEqual({ mode: "portable" });
    expect(safeConfig.skills?.entries?.servers?.config).toEqual({ mode: "collision" });
    expect(safeConfig.mcp?.servers?.auth?.url).toBe("https://mcp.example.test");
    expect(safeConfig.mcp?.servers?.entries?.url).toBe("https://mcp-collision.example.test");
    expect(safeConfig.agents?.defaults?.cliBackends?.custom?.command).toBe("custom-agent");
    expect(safeConfig.agents?.defaults?.cliBackends?.servers?.command).toBe("colliding-agent");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private-key");
    expect(serialized).not.toContain("encrypt-key");
    expect(serialized).not.toContain("encryption-key");
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("encryptKey");
    expect(serialized).not.toContain("encryptionKey");
    expect(serialized).not.toContain("private_key");
    expect(serialized).not.toContain("extraDirs");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("env");
    expect(serialized).not.toContain("/tmp/");
  });

  it("imports missing config and files without overwriting local state", async () => {
    const sourceHome = await createHome("openclaw-profile-source-");
    const sourceState = path.join(sourceHome.home, ".openclaw");
    const sourceWorkspace = path.join(sourceState, "workspace");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-import-"));
    let archivePath = "";
    try {
      await writeJson(path.join(sourceState, "openclaw.json"), {
        ui: { assistant: { name: "From profile" } },
        agents: {
          defaults: {
            workspace: sourceWorkspace,
            model: "openai/gpt-5.4",
          },
        },
        plugins: { entries: { "portable-plugin": { enabled: true } } },
      });
      await fs.mkdir(sourceWorkspace, { recursive: true });
      await fs.writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source agents\n", "utf8");
      await fs.writeFile(path.join(sourceWorkspace, "MEMORY.md"), "source memory\n", "utf8");
      await writeJson(path.join(sourceState, "plugins", "installs.json"), {
        plugins: [],
        installRecords: { "portable-plugin": { source: "npm", spec: "portable-plugin" } },
      });
      archivePath = (
        await createProfileArchive({
          output: outputDir,
          nowMs: Date.UTC(2026, 3, 28, 1),
        })
      ).archivePath;

      await sourceHome.restore();
      tempHomes = tempHomes.filter((entry) => entry !== sourceHome);

      const targetHome = await createHome("openclaw-profile-target-");
      const targetState = path.join(targetHome.home, ".openclaw");
      const targetWorkspace = path.join(targetState, "workspace");
      await writeJson(path.join(targetState, "openclaw.json"), {
        ui: { assistant: { name: "Local" } },
        agents: { defaults: { workspace: targetWorkspace } },
      });
      await fs.mkdir(targetWorkspace, { recursive: true });
      await fs.writeFile(path.join(targetWorkspace, "AGENTS.md"), "local agents\n", "utf8");

      const result = await importProfileArchive({ archive: archivePath });

      expect(result.configAppliedPaths).toEqual(
        expect.arrayContaining(["agents.defaults.model", "plugins.entries.portable-plugin"]),
      );
      expect(result.configSkippedPaths).toContain("ui");
      expect(result.filesSkipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: "AGENTS.md", reason: "exists" }),
        ]),
      );
      expect(await fs.readFile(path.join(targetWorkspace, "AGENTS.md"), "utf8")).toBe(
        "local agents\n",
      );
      expect(await fs.readFile(path.join(targetWorkspace, "MEMORY.md"), "utf8")).toBe(
        "source memory\n",
      );
      const targetConfig = JSON.parse(
        await fs.readFile(path.join(targetState, "openclaw.json"), "utf8"),
      ) as {
        ui: { assistant: { name: string } };
        agents: { defaults: { model?: string; workspace?: string } };
        plugins?: { entries?: Record<string, unknown> };
      };
      expect(targetConfig.ui.assistant.name).toBe("Local");
      expect(targetConfig.agents.defaults.workspace).toBe(targetWorkspace);
      expect(targetConfig.agents.defaults.model).toBe("openai/gpt-5.4");
      expect(targetConfig.plugins?.entries?.["portable-plugin"]).toBeDefined();
      const targetPluginIndex = JSON.parse(
        await fs.readFile(path.join(targetState, "plugins", "installs.json"), "utf8"),
      ) as { installRecords?: Record<string, unknown> };
      expect(targetPluginIndex.installRecords?.["portable-plugin"]).toMatchObject({
        source: "npm",
        spec: "portable-plugin",
      });
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("does not write files during dry-run import", async () => {
    const sourceHome = await createHome("openclaw-profile-dry-source-");
    const sourceState = path.join(sourceHome.home, ".openclaw");
    const sourceWorkspace = path.join(sourceState, "workspace");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-dry-"));
    try {
      await writeJson(path.join(sourceState, "openclaw.json"), {
        agents: { defaults: { workspace: sourceWorkspace, model: "openai/gpt-5.4" } },
      });
      await fs.mkdir(sourceWorkspace, { recursive: true });
      await fs.writeFile(path.join(sourceWorkspace, "MEMORY.md"), "source memory\n", "utf8");
      const archivePath = (
        await createProfileArchive({ output: outputDir, nowMs: Date.UTC(2026, 3, 28, 2) })
      ).archivePath;

      await sourceHome.restore();
      tempHomes = tempHomes.filter((entry) => entry !== sourceHome);

      const targetHome = await createHome("openclaw-profile-dry-target-");
      const targetState = path.join(targetHome.home, ".openclaw");
      const targetWorkspace = path.join(targetState, "workspace");
      await writeJson(path.join(targetState, "openclaw.json"), {
        agents: { defaults: { workspace: targetWorkspace } },
      });

      const result = await importProfileArchive({ archive: archivePath, dryRun: true });

      expect(result.configAppliedPaths).toContain("agents.defaults.model");
      expect(result.filesWritten).toEqual([]);
      expect(result.filesWouldWrite).toEqual(
        expect.arrayContaining([expect.objectContaining({ relativePath: "MEMORY.md" })]),
      );
      await expect(fs.access(path.join(targetWorkspace, "MEMORY.md"))).rejects.toThrow();
      const targetConfig = JSON.parse(
        await fs.readFile(path.join(targetState, "openclaw.json"), "utf8"),
      ) as { agents: { defaults: { model?: string } } };
      expect(targetConfig.agents.defaults.model).toBeUndefined();
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported manifest schemas", async () => {
    await createHome("openclaw-profile-bad-schema-");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-bad-schema-"));
    try {
      const archivePath = path.join(outputDir, "bad-schema.openclaw-profile.tar.gz");
      await writeProfileArchiveFixture(archivePath, {
        "bad-profile/manifest.json": JSON.stringify({
          schemaVersion: 999,
          archiveKind: "openclaw-profile",
          archiveRoot: "bad-profile",
          assets: [],
        }),
      });

      await expect(importProfileArchive({ archive: archivePath })).rejects.toThrow(
        /Unsupported profile manifest schemaVersion/u,
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal paths declared by the manifest", async () => {
    await createHome("openclaw-profile-traversal-");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-traversal-"));
    try {
      const archivePath = path.join(outputDir, "traversal.openclaw-profile.tar.gz");
      await writeProfileArchiveFixture(archivePath, {
        "bad-profile/manifest.json": JSON.stringify({
          schemaVersion: 1,
          archiveKind: "openclaw-profile",
          archiveRoot: "bad-profile",
          assets: [
            {
              kind: "config",
              archivePath: "bad-profile/payload/../escape/openclaw.json",
            },
          ],
        }),
      });

      await expect(importProfileArchive({ archive: archivePath })).rejects.toThrow(
        /path traversal/u,
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects non-markdown memory files declared by the manifest", async () => {
    await createHome("openclaw-profile-non-md-memory-");
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-profile-non-md-memory-"));
    try {
      const archivePath = path.join(outputDir, "non-md-memory.openclaw-profile.tar.gz");
      await writeProfileArchiveFixture(archivePath, {
        "bad-profile/manifest.json": JSON.stringify({
          schemaVersion: 1,
          archiveKind: "openclaw-profile",
          archiveRoot: "bad-profile",
          assets: [
            {
              kind: "config",
              archivePath: "bad-profile/payload/config/openclaw.json",
            },
            {
              kind: "workspace-file",
              archivePath: "bad-profile/payload/workspaces/main/memory/private.json",
              agentId: "main",
              relativePath: "memory/private.json",
            },
          ],
        }),
        "bad-profile/payload/config/openclaw.json": "{}",
        "bad-profile/payload/workspaces/main/memory/private.json": "{}",
      });

      await expect(importProfileArchive({ archive: archivePath })).rejects.toThrow(
        /not importable/u,
      );
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});
