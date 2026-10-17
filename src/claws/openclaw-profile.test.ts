import { createHash } from "node:crypto";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawOpenClawProfile, parseLegacyLocalUpdateClawOpenClawProfile } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function profileFixture(pointer?: string) {
  const root = tempDirs.make("openclaw-claw-profile-");
  await mkdir(join(root, "profiles"));
  const path = join(root, "openclaw.claw.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      agent: { id: "triage" },
      ...(pointer ? { metadata: { "openclaw.config": pointer } } : {}),
    }),
  );
  return { root, path };
}

describe("OpenClaw profile schema", () => {
  it("rejects disabled host filesystem confinement", () => {
    const result = parseClawOpenClawProfile({
      schemaVersion: 1,
      agent: { tools: { fs: { workspaceOnly: false } } },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects retired heartbeat fields with a heartbeat-scoped diagnostic", () => {
    const result = parseClawOpenClawProfile({
      schemaVersion: 1,
      agent: { heartbeat: { every: "30m", skipWhenBusy: true } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "$.agent.heartbeat",
        message: expect.stringContaining("skipWhenBusy"),
      }),
    );
  });

  it("rejects invalid profile policy", () => {
    for (const agent of [
      { tools: { profile: "future-profile" } },
      { tools: { profile: "full" } },
      { tools: { profile: "coding" } },
      { tools: { profile: "messaging" } },
      { tools: { profile: "coding", allow: ["bundle-mcp"] } },
      { tools: { allow: ["bundle-mcp"] } },
      { tools: { allow: ["*"] } },
      { tools: { profile: "coding", allow: ["tts"] } },
      { tools: { profile: "coding", allow: ["read", "tts"] } },
      { tools: { alsoAllow: ["read"] } },
      { tools: { alsoAllow: ["group:plugins"] } },
      { tools: { alsoAllow: ["GROUP:PLUGINS"] } },
      { tools: { allow: ["read"], alsoAllow: ["write"] } },
      { memory: { search: { provider: "openai" } } },
      { memory: { search: { sources: ["sessions"] } } },
    ]) {
      expect(parseClawOpenClawProfile({ schemaVersion: 1, agent }).ok).toBe(false);
    }
  });
});

describe("OpenClaw profile reader", () => {
  it.each([
    ["anchor", "agent: &agent {}", "anchors"],
    ["alias", "agent: *agent", "aliases"],
    ["tag", "agent: !!map {}", "explicit tags"],
    ["merge", "agent: { <<: {} }", "merge keys"],
  ])(
    "rejects profile YAML %s with its profile diagnostic",
    async (_label, declaration, feature) => {
      const { root, path: manifestPath } = await profileFixture();
      await writeFile(join(root, "profiles", "openclaw.yml"), `schemaVersion: 1\n${declaration}\n`);

      const result = await readClawManifestFile(manifestPath);

      expect(result).toMatchObject({
        ok: false,
        diagnostics: [
          {
            level: "error",
            phase: "parse",
            path: "$",
            code: "unsupported_openclaw_profile_yaml_feature",
            message: `profiles/openclaw.yml uses ${feature}; OpenClaw profile YAML must map directly to JSON data.`,
          },
        ],
      });
    },
  );

  it.each([
    ["duplicate key", "schemaVersion: 1\nschemaVersion: 1\nagent: {}\n"],
    ["invalid syntax", "schemaVersion: 1\nagent: [\n"],
  ])("reports a profile YAML %s as a parse failure", async (_label, profile) => {
    const { root, path: manifestPath } = await profileFixture();
    await writeFile(join(root, "profiles", "openclaw.yml"), profile);

    const result = await readClawManifestFile(manifestPath);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          level: "error",
          phase: "parse",
          path: "$",
          code: "invalid_openclaw_profile",
          message: expect.stringContaining("Could not parse profiles/openclaw.yml:"),
        },
      ],
    });
  });

  it("loads and integrity-binds the conventional profile", async () => {
    const root = tempDirs.make("openclaw-claw-profile-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/github-triage",
        version: "3.2.1",
        openclaw: { claw: "CLAW.md" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "CLAW.md"),
      ["---", "schemaVersion: 1", "agent:", "  id: triage", "---", "", "# GitHub Triage"].join(
        "\n",
      ),
      "utf8",
    );
    const profilePath = join(root, "profiles", "openclaw.yml");
    await writeFile(
      profilePath,
      [
        "schemaVersion: 1",
        "agent:",
        "  tools:",
        "    profile: coding",
        "    allow: [read, github__list_issues]",
        "    deny: [exec]",
        "    fs:",
        "      workspaceOnly: true",
      ].join("\n"),
      "utf8",
    );

    const first = await readClawManifestFile(root);
    expect(first).toMatchObject({
      ok: true,
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: {
            profile: "coding",
            allow: ["read", "github__list_issues"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
        },
      },
    });
    if (!first.ok) {
      throw new Error("expected OpenClaw profile to parse");
    }

    await writeFile(
      profilePath,
      "schemaVersion: 1\nagent:\n  tools:\n    profile: messaging\n    allow: [message]\n",
      "utf8",
    );
    const second = await readClawManifestFile(root);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error("expected changed OpenClaw profile to parse");
    }
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });

  it.each([
    { toolProfile: "coding", strictOk: false },
    { toolProfile: "minimal", strictOk: true },
  ] as const)(
    "loads a legacy dynamic $toolProfile profile through the update migration path",
    async ({ toolProfile, strictOk }) => {
      const { root } = await profileFixture();
      await writeFile(
        join(root, "profiles", "openclaw.yml"),
        `schemaVersion: 1\nagent:\n  tools:\n    profile: ${toolProfile}\n`,
        "utf8",
      );

      const manifestPath = join(root, "openclaw.claw.json");
      await expect(readClawManifestFile(manifestPath)).resolves.toMatchObject({ ok: strictOk });
      const migrated = await readClawManifestFile(manifestPath, {
        allowLegacyDynamicToolProfile: true,
      });

      expect(migrated).toMatchObject({
        ok: true,
        openClawProfile: {
          agent: {
            tools: {
              profile: "full",
              allow: expect.not.arrayContaining(["bundle-mcp"]),
            },
          },
        },
        legacyOpenClawProfile: {
          agent: {
            tools: {
              profile: toolProfile,
            },
          },
        },
      });
    },
  );

  it("requires package authors to bound a legacy full profile before update", async () => {
    const { root } = await profileFixture();
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    profile: full\n",
      "utf8",
    );

    const result = await readClawManifestFile(join(root, "openclaw.claw.json"), {
      allowLegacyDynamicToolProfile: true,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          message: expect.stringContaining("bounded explicit allowlist"),
        }),
      ],
    });
  });

  it("validates and strips released v1 host settings only with local update authorization", async () => {
    const { root, path } = await profileFixture();
    const profilePath = join(root, "profiles", "openclaw.yml");
    const raw = Buffer.from(
      [
        "schemaVersion: 1",
        "agent:",
        "  model: { primary: acme/primary, fallbacks: [acme/fallback] }",
        "  subagents: { allowAgents: [researcher], delegationMode: prefer }",
        "  tools: { allow: [read] }",
        "",
      ].join("\n"),
    );
    await writeFile(profilePath, raw);

    const fresh = await readClawManifestFile(path);
    expect(fresh.ok).toBe(false);
    if (fresh.ok) {
      throw new Error("expected fresh legacy source to be rejected");
    }
    const conversion = fresh.diagnostics.find(
      (entry) => entry.code === "legacy_openclaw_profile_requires_conversion",
    );
    expect(conversion).toMatchObject({
      level: "error",
      phase: "schema",
      path: "$.profiles.openclaw.agent",
    });
    expect(conversion?.message).toContain("agent.model and agent.subagents");
    expect(conversion?.message).toContain("profiles/openclaw.yml");
    expect(conversion?.message).toContain("claws add --dry-run");
    const authorized = await readClawManifestFile(path, {
      authorizeLegacyLocalUpdateHostSettings: ({ manifest, source }) =>
        manifest.agent.id === "triage" && source.kind === "development",
    });
    if (!authorized.ok) {
      throw new Error("expected recorded-local profile compatibility to parse");
    }
    expect(authorized.openClawProfile).toEqual({
      schemaVersion: 1,
      agent: { tools: { allow: ["read"] } },
      extensions: [],
    });
    expect(authorized.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "legacy_openclaw_model_ignored",
        path: "$.profiles.openclaw.agent.model",
        message: expect.stringContaining("operator-owned"),
      }),
      expect.objectContaining({
        level: "warning",
        code: "legacy_openclaw_subagents_ignored",
        path: "$.profiles.openclaw.agent.subagents",
        message: expect.stringContaining("operator-owned"),
      }),
    ]);
    expect(authorized.snapshot.openClawProfile?.digest).toBe(
      `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    );
    await writeFile(profilePath, raw.toString("utf8").replace("acme/primary", "acme/changed"));
    const changed = await readClawManifestFile(path, {
      authorizeLegacyLocalUpdateHostSettings: () => true,
    });
    if (!changed.ok) {
      throw new Error("expected changed legacy profile to parse");
    }
    expect(changed.openClawProfile).toEqual(authorized.openClawProfile);
    expect(changed.source.integrity).not.toBe(authorized.source.integrity);
  });

  it.each([
    [{ model: { primary: "not-a-reference" } }, "$.agent.model.primary"],
    [{ model: { primary: "acme/model", provider: "acme" } }, "$.agent.model"],
    [{ subagents: { allowAgents: ["Invalid"] } }, "$.agent.subagents.allowAgents[0]"],
    [{ subagents: { delegationMode: "always" } }, "$.agent.subagents.delegationMode"],
  ])("rejects malformed released v1 host settings at %s", (agent, path) => {
    const parsed = parseLegacyLocalUpdateClawOpenClawProfile({ schemaVersion: 1, agent });
    expect(parsed).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ path })],
    });
  });

  it("does not allow other host-owned profile fields through the legacy reader", () => {
    const parsed = parseLegacyLocalUpdateClawOpenClawProfile({
      schemaVersion: 1,
      agent: { model: { primary: "acme/model" }, provider: "acme" },
    });
    expect(parsed).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ path: "$.agent" })],
    });
  });

  it("combines released v1 host settings with the existing legacy tool migration", async () => {
    const { root, path } = await profileFixture();
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      [
        "schemaVersion: 1",
        "agent:",
        "  model: { primary: acme/model }",
        "  subagents: { allowAgents: [researcher] }",
        "  tools: { profile: coding }",
        "",
      ].join("\n"),
    );
    const migrated = await readClawManifestFile(path, {
      allowLegacyDynamicToolProfile: true,
      authorizeLegacyLocalUpdateHostSettings: () => true,
    });
    if (!migrated.ok) {
      throw new Error("expected combined legacy profile to parse");
    }
    expect(migrated.openClawProfile?.agent).toMatchObject({
      tools: { profile: "full", allow: expect.any(Array) },
    });
    expect(migrated.openClawProfile?.agent).not.toHaveProperty("model");
    expect(migrated.openClawProfile?.agent).not.toHaveProperty("subagents");
    expect(migrated.legacyOpenClawProfile?.agent).not.toHaveProperty("model");
    expect(migrated.legacyOpenClawProfile?.agent).not.toHaveProperty("subagents");
  });

  it("rejects a hardlinked profile", async () => {
    const { root } = await profileFixture();
    const source = join(root, "source.yml");
    await writeFile(source, "schemaVersion: 1\nagent: {}\n", "utf8");
    await link(source, join(root, "profiles", "openclaw.yml"));

    const result = await readClawManifestFile(join(root, "openclaw.claw.json"));

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "openclaw_profile_unsafe" })],
    });
  });
  it("rejects a symlinked profile at the read boundary", async () => {
    const { root, path } = await profileFixture();
    await writeFile(join(root, "source.yml"), "schemaVersion: 1\nagent: {}\n", "utf8");
    await symlink("../source.yml", join(root, "profiles", "openclaw.yml"));

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "openclaw_profile_unsafe" })],
    });
  });

  it("fails closed for an escaping metadata profile pointer", async () => {
    const root = tempDirs.make("openclaw-claw-profile-pointer-");
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "triage" },
        metadata: { "openclaw.config": "../openclaw.yml" },
      }),
      "utf8",
    );
    await writeFile(join(root, "openclaw.yml"), "schemaVersion: 1\nagent: {}\n", "utf8");

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_openclaw_profile_path",
          path: "$.metadata.openclaw.config",
        }),
      ],
    });
  });

  it("still reads the deprecated metadata profile pointer with a warning", async () => {
    const { root, path } = await profileFixture("profiles/triage.openclaw.yml");
    await writeFile(
      join(root, "profiles", "triage.openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    profile: coding\n    allow: [read]\n",
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: true,
      openClawProfile: {
        schemaVersion: 1,
        agent: { tools: { profile: "coding", allow: ["read"] } },
      },
    });
    if (!result.ok) {
      throw new Error("expected the deprecated pointer to keep resolving");
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "deprecated_openclaw_profile_pointer",
        path: "$.metadata.openclaw.config",
      }),
    );
    expect(result.diagnostics.some((entry) => entry.level === "error")).toBe(false);
  });

  it("accepts a deprecated pointer that already targets the conventional profile", async () => {
    const { root, path } = await profileFixture("profiles/openclaw.yml");
    await writeFile(
      join(root, "profiles", "openclaw.yml"),
      "schemaVersion: 1\nagent:\n  tools:\n    profile: coding\n    allow: [read]\n",
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({ ok: true, openClawProfile: { schemaVersion: 1 } });
  });

  it("fails closed when a deprecated pointer diverges from the conventional profile", async () => {
    const { root, path } = await profileFixture("profiles/other.openclaw.yml");
    await writeFile(join(root, "profiles", "openclaw.yml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(root, "profiles", "other.openclaw.yml"), "schemaVersion: 1\n", "utf8");

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "conflicting_openclaw_profile_pointer",
          path: "$.metadata.openclaw.config",
        }),
      ],
    });
  });

  it("does not inspect profiles owned by other harnesses", async () => {
    const { root, path } = await profileFixture();
    await writeFile(join(root, "profiles", "codex.yml"), Buffer.alloc(300 * 1024, "x"));

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error("expected foreign profile to remain opaque");
    }
    expect(result.openClawProfile).toBeUndefined();
  });
});
