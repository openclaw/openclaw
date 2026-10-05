import { afterEach, expect, it, vi } from "vitest";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import type { GatewayClient } from "./server-methods/client-types.js";

afterEach(() => vi.unstubAllEnvs());

it("binds repository effects to the verified operator and current session", () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const client: GatewayClient = {
    authenticatedFactoryGitHubAccountId: 1186191,
    authenticatedUserProfile: {
      profileId: "person",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
  expect(factoryGitHubActorEnvironment(client, "agent:main:own-session")).toMatchObject({
    OPENCLAW_FACTORY_ACTOR_ID: "1186191",
    OPENCLAW_FACTORY_SESSION_KEY: "agent:main:own-session",
  });
  expect(() =>
    factoryGitHubActorEnvironment(
      { ...client, authenticatedFactoryGitHubAccountId: undefined },
      "agent:main:own-session",
    ),
  ).toThrow();
  expect(() =>
    factoryGitHubActorEnvironment(
      { ...client, connect: { ...client.connect, scopes: ["operator.read"] } },
      "agent:main:own-session",
    ),
  ).toThrow();
  expect(() => factoryGitHubActorEnvironment(client, "")).toThrow();
});
