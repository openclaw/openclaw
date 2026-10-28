import fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";

const userId = `U${"1".repeat(32)}`;
const groupId = `C${"2".repeat(32)}`;
const roomId = `R${"3".repeat(32)}`;
const doctorArgs = ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"];

it("preserves scoped group allowlists and diagnoses references without granting access", async () => {
  const accessGroups = { operators: { type: "message.senders", members: {} } };
  const uncoveredId = `C${"3".repeat(32)}`;
  const channel = {
    enabled: true,
    channelAccessToken: "synthetic-line-token",
    channelSecret: "synthetic-line-secret",
    groupPolicy: "allowlist",
    dmPolicy: "disabled",
    groups: {
      [groupId]: { allowFrom: ["accessGroup:operators"] },
      [uncoveredId]: {},
    },
    accounts: {
      aliases: {
        enabled: true,
        channelAccessToken: "synthetic-line-aliases-token",
        channelSecret: "synthetic-line-aliases-secret",
        groupPolicy: "allowlist",
        dmPolicy: "disabled",
        groups: {
          [groupId]: { allowFrom: [userId] },
          [`group:${groupId}`]: { allowFrom: [] },
          [roomId]: { allowFrom: [userId] },
          [`room:${roomId}`]: { allowFrom: [] },
        },
      },
      mixed: {
        enabled: true,
        channelAccessToken: "synthetic-line-mixed-token",
        channelSecret: "synthetic-line-mixed-secret",
        groupPolicy: "allowlist",
        dmPolicy: "disabled",
        groups: {
          [groupId]: { allowFrom: ["accessGroup:operators", userId] },
          [uncoveredId]: {},
        },
      },
    },
  };
  const instance = await createOpenClawTestInstance({
    name: "line-doctor-group-allowlist",
    state: { scenario: "external-service" },
    config: {
      gateway: { mode: "local" },
      plugins: { allow: ["line"], entries: { line: { enabled: true } } },
      accessGroups,
      channels: { line: channel },
    },
  });
  try {
    const retainedEnv = new Set(Object.keys(instance.state.envVars));
    const inheritedEnv = /^(?:PATH|SystemRoot|WINDIR|VITEST|OPENCLAW_TEST_MINIMAL_GATEWAY)$/u;
    for (const key of Object.keys(instance.env)) {
      if (!retainedEnv.has(key) && !inheritedEnv.test(key) && !key.startsWith("OPENCLAW_SKIP_")) {
        delete instance.env[key];
      }
    }
    instance.env.NO_COLOR = "1";

    const result = await instance.cli(doctorArgs);
    const output = stripVTControlCharacters(result.stdout + result.stderr).replace(
      /[│┃\s]+/gu,
      " ",
    );
    expect(result, output).toMatchObject({ code: 0, signal: null });
    const config = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
      channels: {
        line: Record<string, unknown> & { accounts: Record<string, Record<string, unknown>> };
      };
      accessGroups?: Record<string, unknown>;
    };
    expect(config.accessGroups, output).toEqual(accessGroups);
    expect(config.channels.line, output).toMatchObject(channel);
    expect(config.channels.line.groups, output).toEqual(channel.groups);
    expect(config.channels.line.accounts, output).toEqual(channel.accounts);
    for (const scope of [config.channels.line, ...Object.values(config.channels.line.accounts)]) {
      expect(scope, output).not.toHaveProperty("groupAllowFrom");
      expect(scope, output).not.toHaveProperty("allowFrom");
    }

    // The root has references only: concrete senders in another account cannot cover it.
    for (const prefix of ["channels.line", "channels.line.accounts.mixed"]) {
      expect(output).toContain(`${prefix}.groups: group "${groupId}" uses access-group references`);
      expect(output).toContain(
        `${prefix}.groups: group "${uncoveredId}" has no sender allowlist — messages there are silently dropped`,
      );
      expect(output).not.toContain(`${prefix}.groups: group "${groupId}" has no sender allowlist`);
    }
    expect(output).toContain("Check the referenced access groups");
    expect(output).not.toContain("channels.line.accounts.aliases.groups:");
    expect(output).not.toMatch(
      /other groups keep working|all group messages will be silently dropped|empty sender allowlist/u,
    );
  } finally {
    await instance.cleanup();
  }
});
