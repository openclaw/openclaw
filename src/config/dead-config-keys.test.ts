// Verifies schema-only config keys stay outside the canonical config contract.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

function expectUnknownKey(params: { config: Record<string, unknown>; path: string; key: string }) {
  const result = validateConfigObjectRaw(params.config, { validateBundledChannels: true });
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  const issue = result.issues.find(
    (candidate) =>
      candidate.path === params.path &&
      (candidate.message.includes(`Unrecognized key: "${params.key}"`) ||
        candidate.message.includes(`must not have additional properties: "${params.key}"`)),
  );
  if (!issue) {
    throw new Error(`Expected unknown ${params.path}.${params.key} validation issue`);
  }
}

function configWithPath(
  path: string,
  value: unknown = 1,
  siblings: Record<string, unknown> = {},
): Record<string, unknown> {
  const segments = path.split(".");
  const key = segments.pop() ?? "";
  return segments.reduceRight<unknown>(
    (nested, segment) => (segment === "0" ? [nested] : { [segment]: nested }),
    { ...siblings, [key]: value },
  ) as Record<string, unknown>;
}

describe("dead config keys", () => {
  it.each([
    "browser.tabCleanup.sweepMinutes",
    "browser.profiles.chrome.color",
    "agents.defaults.heartbeat.suppressToolErrorWarnings",
    "agents.entries.test.tools.exec.timeoutSec",
    "agents.defaults.sandbox.browser.enableNoVnc",
    "cron.triggers.minIntervalMs",
    "hooks.maxBodyBytes",
    "channels.whatsapp.debounceMs",
    "cloudWorkers.profiles.default.lifetime",
    "mcp.servers.docs.workingDirectory",
    "nodeHost.mcp.servers.docs.workingDirectory",
  ] as const)("rejects retired tuning knob %s", (fullPath) => {
    const segments = fullPath.split(".");
    const key = segments.pop() ?? "";
    expectUnknownKey({
      config: configWithPath(fullPath),
      path: segments.join("."),
      key,
    });
  });

  it.each([
    [
      "file provider insecure-path bypass",
      "allowInsecurePath",
      {
        secrets: {
          providers: {
            legacy: {
              source: "file",
              path: "/tmp/openclaw-secret",
              allowInsecurePath: true,
            },
          },
        },
      },
    ],
    [
      "exec provider symlink bypass",
      "allowSymlinkCommand",
      {
        secrets: {
          providers: {
            legacy: {
              source: "exec",
              command: "/bin/echo",
              allowSymlinkCommand: true,
            },
          },
        },
      },
    ],
  ] as const)("rejects retired secret provider %s", (_name, key, config) => {
    expectUnknownKey({ config, path: "secrets.providers.legacy", key });
  });

  it.each([
    [
      "Slack account",
      "slack",
      { accounts: { work: { dm: { allowFrom: ["U1"] } } } },
      "channels.slack.accounts.work.dm",
      "allowFrom",
    ],
  ] as const)("rejects legacy nested DM aliases for %s", (_name, channel, entry, path, key) => {
    expectUnknownKey({ config: { channels: { [channel]: entry } }, path, key });
  });

  it("rejects unused gateway.remote.enabled", () => {
    expectUnknownKey({
      config: { gateway: { remote: { enabled: false } } },
      path: "gateway.remote",
      key: "enabled",
    });
  });

  it("directs legacy agents.list to Doctor", () => {
    expect(validateConfigObjectRaw({ agents: { list: [{ id: "main" }] } })).toMatchObject({
      ok: false,
      issues: [{ path: "agents.list", message: expect.stringContaining("openclaw doctor --fix") }],
    });
  });

  it.each([
    ["session.maintenance.pruneDays", 7],
    ["talk.realtime.voice", "alloy"],
  ] as const)("rejects retired %s", (fullPath, value, siblings?: Record<string, unknown>) => {
    const segments = fullPath.split(".");
    const key = segments.pop() ?? "";
    expectUnknownKey({
      config: configWithPath(fullPath, value, siblings),
      path: segments.join("."),
      key,
    });
  });
});
