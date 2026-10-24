import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeAll, expect, it } from "vitest";
import { inspectControlUiRootAssets } from "../../src/infra/control-ui-assets.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const userId = `U${"1".repeat(32)}`;
const groupId = `C${"2".repeat(32)}`;
const roomId = `R${"3".repeat(32)}`;
const instances: OpenClawTestInstance[] = [];
const doctorArgs = ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"];

beforeAll(() => {
  // Shared assets must be ready before Doctor starts its per-test CLI timeout.
  const uiRoot = path.resolve(import.meta.dirname, "../../dist/control-ui");
  expect(inspectControlUiRootAssets(uiRoot, null)).toMatchObject({ kind: "ready" });
});

afterEach(() => Promise.all(instances.splice(0).map((instance) => instance.cleanup())));

async function runDoctor(line: Record<string, unknown>, accessGroups?: Record<string, unknown>) {
  const channel = {
    enabled: true,
    channelAccessToken: "synthetic-line-token",
    channelSecret: "synthetic-line-secret",
    groupPolicy: "allowlist",
    dmPolicy: "disabled",
    ...line,
  };
  const instance = await createOpenClawTestInstance({
    name: "line-doctor-group-allowlist",
    state: { scenario: "external-service" },
    config: {
      gateway: { mode: "local" },
      plugins: { allow: ["line"], entries: { line: { enabled: true } } },
      ...(accessGroups ? { accessGroups } : {}),
      channels: { line: channel },
    },
  });
  instances.push(instance);

  const retainedEnv = new Set(Object.keys(instance.state.envVars));
  const inheritedEnv = /^(?:PATH|SystemRoot|WINDIR|VITEST|OPENCLAW_TEST_MINIMAL_GATEWAY)$/u;
  for (const key of Object.keys(instance.env)) {
    if (!retainedEnv.has(key) && !inheritedEnv.test(key) && !key.startsWith("OPENCLAW_SKIP_")) {
      delete instance.env[key];
    }
  }
  instance.env.NO_COLOR = "1";
  expect(await instance.entrypoint()).toEqual([expect.stringMatching(/^dist\/index\.m?js$/u)]);

  const result = await instance.cli(doctorArgs);
  const output = stripVTControlCharacters(result.stdout + result.stderr).replace(/[│┃\s]+/gu, " ");
  expect(result, output).toMatchObject({ code: 0, signal: null });
  expect(output).not.toMatch(/(?:Building Control|Rebuilding stale) UI assets/u);
  const config = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as {
    channels: { line: Record<string, unknown> };
    accessGroups?: Record<string, unknown>;
  };
  expect(config.accessGroups, output).toEqual(accessGroups);
  expect(config.channels.line, output).not.toHaveProperty("groupAllowFrom");
  expect(config.channels.line, output).toMatchObject(channel);
  expect(config.channels.line.groups, output).toEqual(line.groups);
  expect("allowFrom" in config.channels.line, output).toBe("allowFrom" in line);
  return output;
}

it("keeps DM senders out of the group allowlist and explains the missing group list", async () => {
  const output = await runDoctor({ dmPolicy: "allowlist", allowFrom: [userId] });

  expect(output).toContain('channels.line.groupPolicy is "allowlist" but groupAllowFrom is empty');
  expect(output).toContain("this channel does not fall back to allowFrom");
  expect(output).toContain("all group messages will be silently dropped");
  expect(output).not.toContain("sender entry from allowFrom for explicit group allowlist");
});

it("warns when every per-group sender entry normalizes to empty", async () => {
  const output = await runDoctor({ groups: { [groupId]: { allowFrom: [" ", "line:user:"] } } });

  expect(output).toContain("all group messages will be silently dropped");
  expect(output).toContain(`group "${groupId}" resolves to an empty sender allowlist`);
});

it("does not report shadowed group and room aliases as blocked conversations", async () => {
  const output = await runDoctor({
    groups: {
      [groupId]: { allowFrom: [userId] },
      [`group:${groupId}`]: { allowFrom: [] },
      [roomId]: { allowFrom: [userId] },
      [`room:${roomId}`]: { allowFrom: [] },
    },
  });

  expect(output).not.toMatch(
    /all group messages will be silently dropped|empty sender allowlist|no sender allowlist/u,
  );
});

it.each([
  { name: "an empty static access group", members: {}, concrete: [] },
  { name: "an access group with a LINE sender", members: { line: [userId] }, concrete: [] },
  { name: "an access-group reference beside a concrete sender", members: {}, concrete: [userId] },
])("asks to check $name and still names the uncovered group", async ({ members, concrete }) => {
  const accessGroups = { operators: { type: "message.senders", members } };
  const allowFrom = ["accessGroup:operators", ...concrete];
  const uncoveredId = `C${"3".repeat(32)}`;
  const groups = { [groupId]: { allowFrom }, [uncoveredId]: {} };
  const output = await runDoctor({ groups }, accessGroups);

  expect(output).toContain(`group "${groupId}" uses access-group references`);
  expect(output).toContain("Check the referenced access groups");
  expect(output).toContain(
    `group "${uncoveredId}" has no sender allowlist — messages there are silently dropped`,
  );
  expect(output).not.toMatch(
    /other groups keep working|all group messages will be silently dropped|empty sender allowlist/u,
  );
  expect(output).not.toContain(`group "${groupId}" has no sender allowlist`);
});
