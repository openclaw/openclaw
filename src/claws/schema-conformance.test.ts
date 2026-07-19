// Conformance regressions for the portable Claw v1 contract.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";

const baseManifest = {
  schemaVersion: 1,
  agent: { id: "portable-agent" },
  workspace: { files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
} as const;

describe("portable Claw schema conformance", () => {
  it.each(["01.2.3", "1.02.3", "1.2.3-01", "v1.2.3", "1.2.x"])(
    "rejects non-canonical package version %s",
    (version) => {
      const result = parseClawManifest({
        ...baseManifest,
        packages: [{ kind: "skill", source: "clawhub", ref: "demo", version }],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ phase: "schema", path: "$.packages[0].version" }),
      );
    },
  );

  it("requires canonical ClawHub package names", () => {
    const result = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "skill", source: "clawhub", ref: "Demo", version: "1.0.0" }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.packages[0].ref" }),
    );
  });

  it("requires pinned package-manager MCP commands and safe environment keys", () => {
    const unpinned = parseClawManifest({
      ...baseManifest,
      mcpServers: { github: { command: "npx", args: ["--yes", "@acme/github-mcp"] } },
    });
    expect(unpinned.ok).toBe(false);
    expect(unpinned.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.mcpServers.github.args" }),
    );

    const dangerousEnv = parseClawManifest({
      ...baseManifest,
      mcpServers: { github: { command: "node", env: { NODE_OPTIONS: "${NODE_OPTIONS}" } } },
    });
    expect(dangerousEnv.ok).toBe(false);
    expect(dangerousEnv.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.mcpServers.github.env.NODE_OPTIONS" }),
    );
  });

  it("rejects unsafe remote URLs and duplicate tool filters", () => {
    for (const url of [
      "http://example.com/mcp",
      "https://user@example.com/mcp",
      "https://example.com/mcp#fragment",
    ]) {
      const result = parseClawManifest({
        ...baseManifest,
        mcpServers: { remote: { url, transport: "streamable-http" } },
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ path: "$.mcpServers.remote.url" }),
      );
    }

    const duplicate = parseClawManifest({
      ...baseManifest,
      mcpServers: {
        github: { command: "node", toolFilter: { include: ["issues_*", "issues_*"] } },
      },
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.mcpServers.github.toolFilter.include[1]" }),
    );
  });

  it("uses portable workspace collision keys", () => {
    const result = parseClawManifest({
      ...baseManifest,
      workspace: {
        files: [
          { source: "workspace/one.md", path: "Reference/Caf\u00e9.md" },
          { source: "workspace/two.md", path: "reference/Cafe\u0301.md" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.workspace.files[1].path" }),
    );
  });

  it("requires local avatars to be managed workspace destinations", () => {
    const remote = parseClawManifest({
      ...baseManifest,
      agent: { ...baseManifest.agent, identity: { avatar: "https://example.com/avatar.png" } },
    });
    expect(remote.ok).toBe(false);

    const unmanaged = parseClawManifest({
      ...baseManifest,
      agent: { ...baseManifest.agent, identity: { avatar: "avatars/agent.png" } },
    });
    expect(unmanaged.ok).toBe(false);

    const managed = parseClawManifest({
      ...baseManifest,
      agent: { ...baseManifest.agent, identity: { avatar: "avatars/agent.png" } },
      workspace: {
        files: [{ source: "workspace/avatar.png", path: "avatars/agent.png" }],
      },
    });
    expect(managed.ok).toBe(true);
  });

  it("requires portable cron timezone, session, field count, and delivery", () => {
    const valid = {
      id: "daily",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      session: "isolated",
      message: "Summarize status.",
      delivery: { mode: "announce", channel: "last" },
    };
    for (const cronJob of [
      { ...valid, schedule: { cron: "0 9 * * *" } },
      { ...valid, schedule: { cron: "0 0 9 * * *", timezone: "UTC" } },
      { ...valid, session: "current" },
      { ...valid, delivery: { mode: "none", channel: "last" } },
      { ...valid, delivery: { mode: "announce" } },
    ]) {
      expect(parseClawManifest({ ...baseManifest, cronJobs: [cronJob] }).ok).toBe(false);
    }
  });
});

describe("development snapshot integrity", () => {
  it.each([
    ["Demo", "1.0.0"],
    ["demo", "01.0.0"],
  ])("rejects noncanonical package metadata %s@%s", async (name, version) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-package-metadata-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name, version, openclaw: { claw: "openclaw.claw.json" } }),
      "utf8",
    );
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({ schemaVersion: 1, agent: { id: "demo-agent" } }),
      "utf8",
    );

    const result = await readClawManifestFile(root);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid_package_metadata", phase: "parse" }),
    );
  });

  it("binds every referenced workspace source", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-snapshot-"));
    await mkdir(join(root, "workspace"));
    const manifestPath = join(root, "demo.claw.json");
    const sourcePath = join(root, "workspace", "SOUL.md");
    await writeFile(sourcePath, "first\n", "utf8");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "demo-agent" },
        workspace: { bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } } },
      }),
      "utf8",
    );

    const first = await readClawManifestFile(manifestPath);
    await writeFile(sourcePath, "second\n", "utf8");
    const second = await readClawManifestFile(manifestPath);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("expected snapshots to parse");
    }
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });
});
