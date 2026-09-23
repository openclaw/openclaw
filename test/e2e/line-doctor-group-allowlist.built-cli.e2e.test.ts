import fs from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const userId = `U${"1".repeat(32)}`;
const groupId = `C${"2".repeat(32)}`;
const roomId = `R${"3".repeat(32)}`;
const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
});

async function runDoctor(line: Record<string, unknown>, accessGroups?: Record<string, unknown>) {
  const instance = await createOpenClawTestInstance({
    name: "line-doctor-group-allowlist",
    state: { scenario: "external-service" },
    config: {
      gateway: { mode: "local" },
      plugins: { allow: ["line"], entries: { line: { enabled: true } } },
      ...(accessGroups ? { accessGroups } : {}),
      channels: {
        line: {
          enabled: true,
          channelAccessToken: "synthetic-line-token",
          channelSecret: "synthetic-line-secret",
          groupPolicy: "allowlist",
          ...line,
        },
      },
    },
  });
  instances.push(instance);

  // Keep the helper's isolated paths and startup guards, without host credentials.
  const retainedEnv = new Set([
    ...Object.keys(instance.state.envVars),
    "PATH",
    "SystemRoot",
    "WINDIR",
    "VITEST",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
  ]);
  for (const key of Object.keys(instance.env)) {
    if (!retainedEnv.has(key) && !key.startsWith("OPENCLAW_SKIP_")) {
      delete instance.env[key];
    }
  }
  instance.env.NO_COLOR = "1";
  expect(await instance.entrypoint()).toEqual([
    expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
  ]);

  const result = await instance.cli([
    "doctor",
    "--fix",
    "--non-interactive",
    "--no-workspace-suggestions",
  ]);
  const output = stripVTControlCharacters(result.stdout + result.stderr)
    .replace(/[│┃]/gu, " ")
    .replace(/\s+/gu, " ");
  expect(result.code, output).toBe(0);
  expect(result.signal, output).toBeNull();
  const config = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
    channels: { line: Record<string, unknown> };
    accessGroups?: Record<string, unknown>;
  };
  expect(config.accessGroups, output).toEqual(accessGroups);
  expect(config.channels.line, output).not.toHaveProperty("groupAllowFrom");
  expect(config.channels.line, output).toMatchObject({ groupPolicy: "allowlist", ...line });
  return { output, line: config.channels.line };
}

describe("LINE group allowlists through built doctor --fix", () => {
  it("keeps DM senders out of the group allowlist and explains the missing group list", async () => {
    const { output, line } = await runDoctor({ dmPolicy: "allowlist", allowFrom: [userId] });

    expect(line.allowFrom).toEqual([userId]);
    expect(output).toContain(
      'channels.line.groupPolicy is "allowlist" but groupAllowFrom is empty',
    );
    expect(output).toContain("this channel does not fall back to allowFrom");
    expect(output).toContain("all group messages will be silently dropped");
    expect(output).not.toContain("sender entry from allowFrom for explicit group allowlist");
  });

  it("warns when every per-group sender entry normalizes to empty", async () => {
    const { output, line } = await runDoctor({
      dmPolicy: "disabled",
      groups: { [groupId]: { allowFrom: [" ", "line:user:"] } },
    });

    expect(line).not.toHaveProperty("allowFrom");
    expect(output).toContain("all group messages will be silently dropped");
    expect(output).toContain(`group "${groupId}" resolves to an empty sender allowlist`);
  });

  it("does not report shadowed group and room aliases as blocked conversations", async () => {
    const { output, line } = await runDoctor({
      dmPolicy: "disabled",
      groups: {
        [groupId]: { allowFrom: [userId] },
        [`group:${groupId}`]: { allowFrom: [] },
        [roomId]: { allowFrom: [userId] },
        [`room:${roomId}`]: { allowFrom: [] },
      },
    });

    expect(line).not.toHaveProperty("allowFrom");
    expect(output).not.toContain("all group messages will be silently dropped");
    expect(output).not.toContain("empty sender allowlist");
    expect(output).not.toContain("no sender allowlist");
  });

  it.each([
    {
      name: "an empty static access group",
      accessGroups: { empty: { type: "message.senders", members: {} } },
      allowFrom: ["accessGroup:empty"],
    },
    {
      name: "an access group with a LINE sender",
      accessGroups: { operators: { type: "message.senders", members: { line: [userId] } } },
      allowFrom: ["accessGroup:operators"],
    },
    {
      name: "an access-group reference beside a concrete sender",
      accessGroups: { empty: { type: "message.senders", members: {} } },
      allowFrom: ["accessGroup:empty", userId],
    },
  ])(
    "asks to check $name and still names the uncovered group",
    async ({ accessGroups, allowFrom }) => {
      const uncoveredId = `C${"3".repeat(32)}`;
      const groups = { [groupId]: { allowFrom }, [uncoveredId]: {} };
      const { output, line } = await runDoctor({ dmPolicy: "disabled", groups }, accessGroups);

      expect(line).not.toHaveProperty("allowFrom");
      expect(line.groups).toEqual(groups);
      expect(output).toContain(`group "${groupId}" uses access-group references`);
      expect(output).toContain("Check the referenced access groups");
      expect(output).toContain(
        `group "${uncoveredId}" has no sender allowlist — messages there are silently dropped`,
      );
      expect(output).not.toContain("other groups keep working");
      expect(output).not.toContain("all group messages will be silently dropped");
      expect(output).not.toContain("empty sender allowlist");
      expect(output).not.toContain(`group "${groupId}" has no sender allowlist`);
    },
  );
});
