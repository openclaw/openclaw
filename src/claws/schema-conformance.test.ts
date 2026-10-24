// Conformance regressions for the portable Claw v1 contract.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClawManifestFile } from "./reader.js";
import { parseClawManifest } from "./schema.js";
import type { ClawDiagnostic } from "./types.js";

const baseManifest = {
  schemaVersion: 1,
  agent: { id: "portable-agent" },
  workspace: { files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
} as const;

const parseMcp = (github: unknown) =>
  parseClawManifest({ ...baseManifest, mcpServers: { github } });
const parseNpx = (...args: string[]) => parseMcp({ command: "npx", args });
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), "utf8");
function expectInvalid(
  result: Pick<ReturnType<typeof parseClawManifest>, "ok" | "diagnostics">,
  diagnostic: string | Partial<ClawDiagnostic>,
) {
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining(typeof diagnostic === "string" ? { path: diagnostic } : diagnostic),
  );
}

describe("portable Claw schema conformance", () => {
  it("preserves optional portable categories", () => {
    const result = parseClawManifest({ ...baseManifest, categories: ["travel", "personal"] });
    expect(result).toMatchObject({ ok: true, manifest: { categories: ["travel", "personal"] } });
    expect(parseClawManifest(baseManifest).ok).toBe(true);
    expect(parseClawManifest({ ...baseManifest, categories: ["custom"] }).ok).toBe(true);
  });

  it.each([
    { categories: [] },
    { categories: ["travel", "travel"] },
    { categories: ["Travel"] },
    { categories: ["travel", "personal", "health", "research"] },
  ])("rejects invalid category declarations %j", ({ categories }) => {
    const result = parseClawManifest({ ...baseManifest, categories });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.path?.startsWith("$.categories")),
    ).toBe(true);
  });

  it("requires exact package versions", () => {
    const result = parseClawManifest({
      ...baseManifest,
      packages: [{ kind: "skill", source: "clawhub", ref: "demo", version: "latest" }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.path).toBe("$.packages[0].version");
  });

  it("requires pinned package-manager MCP commands and safe environment keys", () => {
    expectInvalid(parseNpx("--yes", "@acme/github-mcp"), "$.mcpServers.github.args");

    expectInvalid(
      parseNpx("--package", "safe@1.0.0", "--package", "unsafe@latest", "server"),
      "$.mcpServers.github.args",
    );

    expect(parseNpx("unsafe@latest", "--package", "safe@1.0.0").ok).toBe(false);

    expect(parseNpx("--package", "safe@1.0.0", "server", "--package", "child-arg").ok).toBe(true);

    expectInvalid(
      parseMcp({ command: "node", env: { NODE_OPTIONS: "${NODE_OPTIONS}" } }),
      "$.mcpServers.github.env.NODE_OPTIONS",
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
      expectInvalid(result, "$.mcpServers.remote.url");
    }

    expectInvalid(
      parseMcp({ command: "node", toolFilter: { include: ["issues_*", "issues_*"] } }),
      "$.mcpServers.github.toolFilter.include[1]",
    );

    for (const pattern of ["issue?", "issue[0-9]"]) {
      expectInvalid(
        parseMcp({ command: "node", toolFilter: { include: [pattern] } }),
        "$.mcpServers.github.toolFilter.include[0]",
      );
    }
  });

  it("requires local avatars to be managed workspace destinations", () => {
    const parseAvatar = (avatar: string, files: { source: string; path: string }[] = []) =>
      parseClawManifest({
        ...baseManifest,
        agent: { ...baseManifest.agent, identity: { avatar } },
        workspace: { files },
      });
    expect(parseAvatar("https://example.com/avatar.png").ok).toBe(false);
    expect(parseAvatar("avatars/agent.png").ok).toBe(false);
    expect(
      parseAvatar("avatars/agent.png", [
        { source: "workspace/avatar.png", path: "avatars/agent.png" },
      ]).ok,
    ).toBe(true);
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
  it("rejects noncanonical package metadata demo@01.0.0", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-package-metadata-"));
    await writeJson(join(root, "package.json"), {
      name: "demo",
      version: "01.0.0",
      openclaw: { claw: "openclaw.claw.json" },
    });
    await writeJson(join(root, "openclaw.claw.json"), baseManifest);
    expectInvalid(await readClawManifestFile(root), {
      code: "invalid_package_metadata",
      phase: "parse",
    });
  });

  it("binds every referenced workspace source", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-claw-snapshot-"));
    await mkdir(join(root, "workspace"));
    const manifestPath = join(root, "demo.claw.json");
    const sourcePath = join(root, "workspace", "SOUL.md");
    await writeFile(sourcePath, "first\n", "utf8");
    await writeJson(manifestPath, {
      ...baseManifest,
      workspace: { bootstrapFiles: { "SOUL.md": { source: "workspace/SOUL.md" } } },
    });

    const first = await readClawManifestFile(manifestPath);
    await writeFile(sourcePath, "second\n", "utf8");
    const second = await readClawManifestFile(manifestPath);
    assert(first.ok && second.ok, "expected snapshots to parse");
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });
});
