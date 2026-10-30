import { expect, it } from "vitest";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const envRef = (id: string) => ({ source: "env", provider: "default", id });
function prepare(config: unknown, env: NodeJS.ProcessEnv = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });
}

it("resolves system and agent App signing keys without rewriting source refs", async () => {
  const app = {
    appId: 101,
    installationId: 202,
    accountId: 303,
    repositories: [{ id: 404, fullName: "example/project" }],
    permissions: { contents: "write" },
    keyVersion: "fixture-generation",
    privateKey: envRef("GITHUB_APP_KEY"),
  };
  const github = { profileId: "ghp_" + "a".repeat(32), kind: "app-installation", app };
  const snapshot = await prepare(
    { tools: { github }, agents: { entries: { main: { tools: { github } } } } },
    { GITHUB_APP_KEY: "synthetic-app-key" },
  );
  const resolved = { kind: "app-installation", app: { privateKey: "synthetic-app-key" } };
  expect(snapshot.config.tools?.github).toMatchObject(resolved);
  expect(snapshot.config.agents?.entries?.main?.tools?.github).toMatchObject(resolved);
  expect(app.privateKey).toEqual(envRef("GITHUB_APP_KEY"));
});

it.each([
  [
    "preview credential",
    {},
    [["controlUi.github.token", "CONTROL_UI_GITHUB_TOKEN", "resolved-preview-token"]],
  ],
  [
    "local credentials",
    { mode: "local", auth: { mode: "password", token: "local-token", password: "local-password" } },
    [
      ["remote.token", "MISSING_REMOTE_TOKEN", undefined],
      ["remote.password", "MISSING_REMOTE_PASSWORD", undefined],
    ],
  ],
  [
    "trusted proxy password",
    { auth: { mode: "trusted-proxy" } },
    [["auth.password", "GATEWAY_PASSWORD_REF", "resolved-gateway-password"]],
  ],
  [
    "remote token wins",
    { mode: "local", remote: { token: "remote-token" } },
    [["auth.password", "GATEWAY_PASSWORD_REF", undefined]],
  ],
  [
    "local trusted proxy",
    { mode: "local", auth: { mode: "trusted-proxy" } },
    [
      ["remote.token", "REMOTE_GATEWAY_TOKEN_REF", undefined],
      ["remote.password", "REMOTE_GATEWAY_PASSWORD_REF", undefined],
    ],
  ],
  [
    "remote password can win",
    { mode: "local" },
    [["remote.password", "REMOTE_GATEWAY_PASSWORD_REF", "resolved-remote-gateway-password"]],
  ],
  [
    "tailscale serve",
    { mode: "local", tailscale: { mode: "serve" } },
    [
      ["remote.token", "REMOTE_GATEWAY_TOKEN", "tailscale-remote-token"],
      ["remote.password", "REMOTE_GATEWAY_PASSWORD", "tailscale-remote-password"],
    ],
  ],
] as const)("resolves only active gateway refs: %s", async (_name, settings, fields) => {
  const gateway = structuredClone(settings);
  const env: NodeJS.ProcessEnv = {};
  for (const [field, id, value] of fields) {
    setPathCreateStrict(gateway, field.split("."), envRef(id));
    if (value) {
      env[id] = value;
    }
  }
  const snapshot = await prepare({ gateway }, env);
  for (const [field, id, value] of fields) {
    expect(getPath(snapshot.config.gateway, field.split("."))).toEqual(value ?? envRef(id));
    expect(snapshot.warnings.some(({ path }) => path === `gateway.${field}`)).toBe(
      value === undefined,
    );
  }
});
