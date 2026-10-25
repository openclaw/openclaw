import { createHash } from "node:crypto";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawOpenClawProfile, parseLegacyLocalUpdateClawOpenClawProfile } from "./schema.js";
import type { ClawDiagnostic } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function profileFixture(profile?: string, pointer?: string) {
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
  const profilePath = join(root, pointer ?? "profiles/openclaw.yml");
  const write = (content: string | Buffer) => writeFile(profilePath, content);
  if (profile !== undefined) {
    await write(profile);
  }
  return {
    root,
    path,
    write,
    read: (options?: Parameters<typeof readClawManifestFile>[1]) =>
      readClawManifestFile(path, options),
  };
}

const profileYaml = (agent: object = {}) => `schemaVersion: 1\nagent: ${JSON.stringify(agent)}\n`;
async function readProfile(profile: string, pointer?: string) {
  const { path } = await profileFixture(profile, pointer);
  return readClawManifestFile(path);
}
function expectProfileFailure(result: unknown, diagnostic: Partial<ClawDiagnostic>) {
  expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining(diagnostic)] });
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

    assert(!result.ok);
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
    { location: "conventional", pointer: undefined },
    { location: "legacy", pointer: "legacy.yml" },
  ])(
    "rejects malformed UTF-8 in a $location profile and accepts repaired Unicode",
    async ({ pointer }) => {
      const { read, write } = await profileFixture(undefined, pointer);
      const content = profileYaml({ groupChat: { mentionPatterns: ["@café �"] } });
      await write(Buffer.from(content.replace(" �", ""), "latin1"));

      expectProfileFailure(await read(), {
        code: "openclaw_profile_read_failed",
        path: pointer ? "$.metadata.openclaw.config" : "$.profiles.openclaw",
        message: expect.stringContaining("must be valid UTF-8"),
      });

      await write(`\uFEFF${content}`);
      expect(await read()).toMatchObject({
        ok: true,
        openClawProfile: { agent: { groupChat: { mentionPatterns: ["@café �"] } } },
      });
    },
  );

  it("reports unsupported YAML features with the profile diagnostic", async () => {
    expectProfileFailure(await readProfile("schemaVersion: 1\nagent: &agent {}\n"), {
      code: "unsupported_openclaw_profile_yaml_feature",
      path: "$",
      level: "error",
      phase: "parse",
      message:
        "profiles/openclaw.yml uses anchors; OpenClaw profile YAML must map directly to JSON data.",
    });
  });

  it.each([
    ["duplicate key", "schemaVersion: 1\nschemaVersion: 1\nagent: {}\n"],
    ["invalid syntax", "schemaVersion: 1\nagent: [\n"],
  ])("reports a profile YAML %s as a parse failure", async (_label, profile) => {
    expectProfileFailure(await readProfile(profile), {
      code: "invalid_openclaw_profile",
      path: "$",
      level: "error",
      phase: "parse",
      message: expect.stringContaining("Could not parse profiles/openclaw.yml:"),
    });
  });

  it.each([undefined, "profiles/triage.openclaw.yml", "profiles/openclaw.yml"])(
    "loads and integrity-binds the profile with pointer %s",
    async (pointer) => {
      const { read, write } = await profileFixture(
        profileYaml({
          tools: {
            profile: "coding",
            allow: ["read", "github__list_issues"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
        }),
        pointer,
      );
      const first = await read();
      assert(first.ok, "expected OpenClaw profile to parse");
      expect(first.openClawProfile?.schemaVersion).toBe(1);
      expect(first.openClawProfile?.agent.tools).toEqual({
        profile: "coding",
        allow: ["read", "github__list_issues"],
        deny: ["exec"],
        fs: { workspaceOnly: true },
      });
      if (pointer) {
        expect(first.diagnostics).toContainEqual(
          expect.objectContaining({
            level: "warning",
            code: "deprecated_openclaw_profile_pointer",
            path: "$.metadata.openclaw.config",
          }),
        );
        expect(first.diagnostics.some((entry) => entry.level === "error")).toBe(false);
      }

      await write(profileYaml({ tools: { profile: "messaging", allow: ["message"] } }));
      const second = await read();
      assert(second.ok, "expected changed OpenClaw profile to parse");
      expect(second.source.integrity).not.toBe(first.source.integrity);
    },
  );

  it.each([
    { toolProfile: "coding", strictOk: false },
    { toolProfile: "minimal", strictOk: true },
  ] as const)(
    "loads a legacy dynamic $toolProfile profile through the update migration path",
    async ({ toolProfile, strictOk }) => {
      const { read } = await profileFixture(profileYaml({ tools: { profile: toolProfile } }));
      await expect(read()).resolves.toMatchObject({ ok: strictOk });
      const migrated = await read({ allowLegacyDynamicToolProfile: true });

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
      });
    },
  );

  it("requires package authors to bound a legacy full profile before update", async () => {
    const { read } = await profileFixture(profileYaml({ tools: { profile: "full" } }));
    const result = await read({ allowLegacyDynamicToolProfile: true });

    expectProfileFailure(result, {
      message: expect.stringContaining("bounded explicit allowlist"),
    });
  });

  it("validates and strips released v1 host settings only with local update authorization", async () => {
    const { read, write } = await profileFixture();
    const raw = Buffer.from(
      profileYaml({
        model: { primary: "acme/primary", fallbacks: ["acme/fallback"] },
        subagents: { allowAgents: ["researcher"], delegationMode: "prefer" },
        tools: { allow: ["read"] },
      }),
    );
    await write(raw);

    const fresh = await read();
    assert(!fresh.ok, "expected fresh legacy source to be rejected");
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
    const authorized = await read({
      authorizeLegacyLocalUpdateHostSettings: ({ manifest, source }) =>
        manifest.agent.id === "triage" && source.kind === "development",
    });
    assert(authorized.ok, "expected recorded-local profile compatibility to parse");
    expect(authorized.openClawProfile).toEqual({
      schemaVersion: 1,
      agent: { tools: { allow: ["read"] } },
      extensions: [],
    });
    expect(authorized.diagnostics).toEqual(
      ["model", "subagents"].map((field) =>
        expect.objectContaining({
          level: "warning",
          code: `legacy_openclaw_${field}_ignored`,
          path: `$.profiles.openclaw.agent.${field}`,
          message: expect.stringContaining("operator-owned"),
        }),
      ),
    );
    expect(authorized.snapshot.openClawProfile?.digest).toBe(
      `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    );
    await write(raw.toString("utf8").replace("acme/primary", "acme/changed"));
    const changed = await read({
      authorizeLegacyLocalUpdateHostSettings: () => true,
    });
    assert(changed.ok, "expected changed legacy profile to parse");
    expect(changed.openClawProfile).toEqual(authorized.openClawProfile);
    expect(changed.source.integrity).not.toBe(authorized.source.integrity);
  });

  it.each([
    [{ model: { primary: "not-a-reference" } }, "$.agent.model.primary"],
    [{ model: { primary: "acme/model", provider: "acme" } }, "$.agent.model"],
    [{ subagents: { allowAgents: ["Invalid"] } }, "$.agent.subagents.allowAgents[0]"],
    [{ subagents: { delegationMode: "always" } }, "$.agent.subagents.delegationMode"],
    [{ model: { primary: "acme/model" }, provider: "acme" }, "$.agent"],
  ])("rejects malformed released v1 host settings at %s", (agent, path) => {
    const parsed = parseLegacyLocalUpdateClawOpenClawProfile({ schemaVersion: 1, agent });
    expectProfileFailure(parsed, { path });
  });

  it("combines released v1 host settings with the existing legacy tool migration", async () => {
    const { read } = await profileFixture(
      profileYaml({
        model: { primary: "acme/model" },
        subagents: { allowAgents: ["researcher"] },
        tools: { profile: "coding" },
      }),
    );
    const migrated = await read({
      allowLegacyDynamicToolProfile: true,
      authorizeLegacyLocalUpdateHostSettings: () => true,
    });
    assert(migrated.ok, "expected combined legacy profile to parse");
    expect(migrated.openClawProfile?.agent).toMatchObject({
      tools: { profile: "full", allow: expect.any(Array) },
    });
    expect(migrated.openClawProfile?.agent).not.toHaveProperty("model");
    expect(migrated.openClawProfile?.agent).not.toHaveProperty("subagents");
  });

  it.each(["hardlink", "symlink"])("rejects a %s profile at the read boundary", async (kind) => {
    const { root, read } = await profileFixture();
    const source = join(root, "source.yml");
    await writeFile(source, "schemaVersion: 1\nagent: {}\n", "utf8");
    const target = join(root, "profiles", "openclaw.yml");
    if (kind === "hardlink") {
      await link(source, target);
    } else {
      await symlink("../source.yml", target);
    }
    expectProfileFailure(await read(), { code: "openclaw_profile_unsafe" });
  });

  it("fails closed for an escaping metadata profile pointer", async () => {
    const { root, path } = await profileFixture(undefined, "../openclaw.yml");
    await writeFile(join(root, "openclaw.yml"), "schemaVersion: 1\nagent: {}\n", "utf8");

    expectProfileFailure(await readClawManifestFile(path), {
      code: "invalid_openclaw_profile_path",
      path: "$.metadata.openclaw.config",
    });
  });

  it("fails closed when a deprecated pointer diverges from the conventional profile", async () => {
    const { root, path } = await profileFixture(undefined, "profiles/other.openclaw.yml");
    await writeFile(join(root, "profiles", "openclaw.yml"), "schemaVersion: 1\n", "utf8");
    await writeFile(join(root, "profiles", "other.openclaw.yml"), "schemaVersion: 1\n", "utf8");

    expectProfileFailure(await readClawManifestFile(path), {
      code: "conflicting_openclaw_profile_pointer",
      path: "$.metadata.openclaw.config",
    });
  });

  it("does not inspect profiles owned by other harnesses", async () => {
    const { root, path } = await profileFixture();
    await writeFile(join(root, "profiles", "codex.yml"), Buffer.alloc(300 * 1024, "x"));

    const result = await readClawManifestFile(path);

    assert(result.ok, "expected foreign profile to remain opaque");
    expect(result.openClawProfile).toBeUndefined();
  });
});
