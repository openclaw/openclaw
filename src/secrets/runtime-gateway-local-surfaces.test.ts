/** Tests local gateway credential surfaces and their active/inactive SecretRef states. */
import { describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

function envRef(id: string) {
  return { source: "env", provider: "default", id };
}

function prepare(config: unknown, env: NodeJS.ProcessEnv = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env,
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => ({ version: 1, profiles: {} }),
  });
}

function expectInactiveRemote(
  snapshot: Awaited<ReturnType<typeof prepare>>,
  tokenId: string,
  passwordId: string,
) {
  const remote = snapshot.config.gateway?.remote;
  expect([remote?.token, remote?.password]).toEqual([envRef(tokenId), envRef(passwordId)]);
  expect(snapshot.warnings.map(({ path }) => path)).toEqual(
    expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
  );
}

describe("secrets runtime gateway local surfaces", () => {
  it("resolves selected system and agent App signing keys without rewriting source refs", async () => {
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

  it("resolves the Control UI GitHub preview credential independently", async () => {
    const snapshot = await prepare(
      { gateway: { controlUi: { github: { token: envRef("CONTROL_UI_GITHUB_TOKEN") } } } },
      { CONTROL_UI_GITHUB_TOKEN: "resolved-preview-token" },
    );
    expect(snapshot.config.gateway?.controlUi?.github?.token).toBe("resolved-preview-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.controlUi.github.token",
    );
  });

  it("treats gateway.remote refs as inactive when local auth credentials are configured", async () => {
    const snapshot = await prepare({
      gateway: {
        mode: "local",
        auth: { mode: "password", token: "local-token", password: "local-password" },
        remote: {
          token: envRef("MISSING_REMOTE_TOKEN"),
          password: envRef("MISSING_REMOTE_PASSWORD"),
        },
      },
    });
    expectInactiveRemote(snapshot, "MISSING_REMOTE_TOKEN", "MISSING_REMOTE_PASSWORD");
  });

  it("treats gateway.auth.password ref as active when auth mode is trusted-proxy", async () => {
    const snapshot = await prepare(
      { gateway: { auth: { mode: "trusted-proxy", password: envRef("GATEWAY_PASSWORD_REF") } } },
      { GATEWAY_PASSWORD_REF: "resolved-gateway-password" },
    );
    expect(snapshot.config.gateway?.auth?.password).toBe("resolved-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.password");
  });

  it("treats gateway.auth.password ref as inactive when remote token is configured", async () => {
    const snapshot = await prepare({
      gateway: {
        mode: "local",
        auth: { password: envRef("GATEWAY_PASSWORD_REF") },
        remote: { token: "remote-token" },
      },
    });
    expect(snapshot.config.gateway?.auth?.password).toEqual(envRef("GATEWAY_PASSWORD_REF"));
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
  });

  it("treats gateway.remote refs as inactive in local mode when auth mode is trusted-proxy", async () => {
    const snapshot = await prepare({
      gateway: {
        mode: "local",
        auth: { mode: "trusted-proxy" },
        remote: {
          token: envRef("REMOTE_GATEWAY_TOKEN_REF"),
          password: envRef("REMOTE_GATEWAY_PASSWORD_REF"),
        },
      },
    });
    expectInactiveRemote(snapshot, "REMOTE_GATEWAY_TOKEN_REF", "REMOTE_GATEWAY_PASSWORD_REF");
  });

  it("treats gateway.remote.password ref as active in local mode when password can win", async () => {
    const snapshot = await prepare(
      { gateway: { mode: "local", remote: { password: envRef("REMOTE_GATEWAY_PASSWORD_REF") } } },
      { REMOTE_GATEWAY_PASSWORD_REF: "resolved-remote-gateway-password" },
    );
    expect(snapshot.config.gateway?.remote?.password).toBe("resolved-remote-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });

  it("treats gateway.remote refs as active when tailscale serve is enabled", async () => {
    const snapshot = await prepare(
      {
        gateway: {
          mode: "local",
          tailscale: { mode: "serve" },
          remote: {
            token: envRef("REMOTE_GATEWAY_TOKEN"),
            password: envRef("REMOTE_GATEWAY_PASSWORD"),
          },
        },
      },
      {
        REMOTE_GATEWAY_TOKEN: "tailscale-remote-token",
        REMOTE_GATEWAY_PASSWORD: "tailscale-remote-password",
      },
    );
    const remote = snapshot.config.gateway?.remote;
    expect([remote?.token, remote?.password]).toEqual([
      "tailscale-remote-token",
      "tailscale-remote-password",
    ]);
    const warnings = snapshot.warnings.map((warning) => warning.path);
    expect(warnings).not.toContain("gateway.remote.token");
    expect(warnings).not.toContain("gateway.remote.password");
  });
});
