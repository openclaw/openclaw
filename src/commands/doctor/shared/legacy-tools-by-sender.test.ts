import { describe, expect, it } from "vitest";
import { getConfigValueAtPath, setConfigValueAtPath } from "../../../config/config-paths.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { resolveToolsBySender } from "../../../config/tools-by-sender.js";
import type { GroupToolPolicyBySenderConfig } from "../../../config/types.tools.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("Doctor sender tool policy migration", () => {
  const opaque = { toolsBySender: { external: { template: "unchanged" } } };
  const canonical: GroupToolPolicyBySenderConfig = {
    "id:@alice:example.invalid": { deny: ["exec"] },
    "channel:matrix:@alice:example.invalid": { deny: ["write"] },
    "e164:+15550001111": { allow: ["read"] },
    "username:@alice": { allow: ["read"] },
    "name:Alice": { deny: ["exec"] },
    "*": { deny: ["exec"] },
  };
  it.each([
    {
      agents: {
        defaults: { params: opaque },
        entries: { main: { models: { "example/model": { params: opaque } } } },
      },
      plugins: { entries: { example: { config: opaque } } },
      channels: { example: { groups: { room: opaque } } },
    },
    { channels: { whatsapp: { groups: { "123@g.us": { toolsBySender: canonical } } } } },
  ])("leaves canonical and opaque sender policies unchanged: %j", (raw) => {
    const original = structuredClone(raw);
    expect(validateConfigObjectRaw(raw).ok).toBe(true);
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(
      applyLegacyDoctorMigrations(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts: false,
      }),
    ).toEqual({ next: null, changes: [] });
    expect(migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw }).changes).toEqual([]);
    expect(raw).toEqual(original);
  });

  it.each([
    "tools.toolsBySender",
    "agents.entries.main.tools.toolsBySender",
    "channels.slack.accounts.work.channels.general.toolsBySender",
    "channels.discord.guilds.guild.channels.general.toolsBySender",
    "channels.msteams.teams.team.channels.general.toolsBySender",
    "channels.telegram.direct.user.toolsBySender",
  ])("migrates the declared policy scope %s", (location) => {
    const raw: Record<string, unknown> = {};
    const path = location.split(".");
    setConfigValueAtPath(raw, path, { Alice: { deny: ["exec"] } });
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Untyped toolsBySender") }),
    );
    const migrated = applyLegacyDoctorMigrations(raw, {
      sourceConfigBeforeMigrations: raw,
      pluginContracts: false,
    });
    expect(getConfigValueAtPath(migrated.next ?? {}, path)).toEqual({
      "id:Alice": { deny: ["exec"] },
    });
  });

  it("removes no-effect empty keys without creating sender identities and is idempotent", () => {
    const raw = {
      tools: {
        toolsBySender: {
          "": { allow: ["exec"] },
          " \t ": { deny: ["read"] },
          "@": { allow: ["write"] },
          Alice: { deny: ["exec"] },
          "*": { deny: ["write"] },
        },
      },
    };
    const original = structuredClone(raw);
    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(migrated.partiallyValid).toBeUndefined();
    const toolsBySender = migrated.sourceConfig?.tools?.toolsBySender;
    expect(toolsBySender).toEqual({
      "id:Alice": { deny: ["exec"] },
      "*": { deny: ["write"] },
    });
    expect(validateConfigObjectRaw(migrated.sourceConfig).ok).toBe(true);
    expect(resolveToolsBySender({ toolsBySender, senderId: "Alice" })).toEqual({ deny: ["exec"] });
    expect(resolveToolsBySender({ toolsBySender, senderId: "other" })).toEqual({ deny: ["write"] });
    expect(migrated.changes).toContain(
      "tools.toolsBySender: removed 3 empty untyped sender key(s) that matched no sender; original entries remain in the config backup.",
    );
    expect(raw).toEqual(original);
    expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
    expect(
      migrateLegacyConfig(migrated.sourceConfig, {
        sourceConfigBeforeMigrations: migrated.sourceConfig,
      }).changes,
    ).toEqual([]);
  });

  it.each([
    {
      name: "legacy before typed",
      policies: { " @Alice ": { deny: ["exec"] }, "ID: ALICE": { allow: ["exec"] } },
      expectedKey: "id:Alice",
      senderId: "@ALICE",
    },
    {
      name: "typed before legacy",
      policies: { "ID: ALICE": { deny: ["exec"] }, " @Alice ": { allow: ["exec"] } },
      expectedKey: "ID: ALICE",
      senderId: "@ALICE",
    },
    {
      name: "normalized legacy collision",
      policies: { " @Alice ": { deny: ["exec"] }, ALICE: { allow: ["exec"] } },
      expectedKey: "id:Alice",
      senderId: "@ALICE",
    },
  ])("preserves the first effective policy for $name", ({ policies, expectedKey, senderId }) => {
    const raw = {
      channels: { whatsapp: { groups: { "123@g.us": { toolsBySender: policies } } } },
    };
    const original = structuredClone(raw);
    expect(validateConfigObjectRaw(raw)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("openclaw doctor --fix") }),
      ]),
    });
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("Untyped toolsBySender") }),
    );

    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(migrated.partiallyValid).toBeUndefined();
    const toolsBySender =
      migrated.sourceConfig?.channels?.whatsapp?.groups?.["123@g.us"]?.toolsBySender;
    expect(toolsBySender).toEqual({ [expectedKey]: { deny: ["exec"] } });
    expect(resolveToolsBySender({ toolsBySender, senderId })).toEqual({ deny: ["exec"] });
    expect(migrated.changes).toContainEqual(expect.stringContaining("first matching policy"));
    expect(raw).toEqual(original);
    expect(findLegacyConfigIssues(migrated.sourceConfig)).toEqual([]);
    expect(
      migrateLegacyConfig(migrated.sourceConfig, {
        sourceConfigBeforeMigrations: migrated.sourceConfig,
      }).changes,
    ).toEqual([]);
  });

  it("migrates nested account policies without changing typed matching or colon IDs", () => {
    const raw = {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              groups: {
                "123@g.us": {
                  toolsBySender: {
                    "@alice:example.invalid": { deny: ["exec"] },
                    "id:@alice:example.invalid": { deny: ["write"] },
                    "discord:user:alice": { allow: ["read"] },
                    "channel:discord:user:alice": { deny: ["read"] },
                    "username:alice": { allow: ["exec"] },
                    "*": { deny: ["write", "exec"] },
                  },
                },
              },
            },
          },
        },
      },
    };
    const migrated = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(migrated.partiallyValid).toBeUndefined();
    const toolsBySender =
      migrated.sourceConfig?.channels?.whatsapp?.accounts?.work?.groups?.["123@g.us"]
        ?.toolsBySender;
    expect(toolsBySender).toEqual({
      "id:alice:example.invalid": { deny: ["exec"] },
      "id:@alice:example.invalid": { deny: ["write"] },
      "id:discord:user:alice": { allow: ["read"] },
      "channel:discord:user:alice": { deny: ["read"] },
      "username:alice": { allow: ["exec"] },
      "*": { deny: ["write", "exec"] },
    });
    for (const [sender, policy] of [
      [{ senderId: "@alice:example.invalid" }, { deny: ["write"] }],
      [{ senderId: "alice:example.invalid" }, { deny: ["exec"] }],
      [{ senderId: "discord:user:alice", messageProvider: "slack" }, { allow: ["read"] }],
      [{ senderId: "user:alice", messageProvider: "discord" }, { deny: ["read"] }],
      [{ senderId: "other", senderName: "alice:example.invalid" }, { deny: ["write", "exec"] }],
    ] as const) {
      expect(resolveToolsBySender({ toolsBySender, ...sender })).toEqual(policy);
    }
  });
});
