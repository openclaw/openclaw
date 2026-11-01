import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayInteractiveSurfaceAuth as interactiveAuth,
  resolveGatewayProbeSurfaceAuth as probeAuth,
} from "./auth-surface-resolution.js";

const ambientAuth: NodeJS.ProcessEnv = {
  OPENCLAW_GATEWAY_TOKEN: "ambient-token",
  OPENCLAW_GATEWAY_PASSWORD: "ambient-password", // pragma: allowlist secret
};

const missingSecretRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

function params(
  gateway: NonNullable<OpenClawConfig["gateway"]>,
  surface: "local" | "remote" = "local",
) {
  return {
    config: { gateway, secrets: { providers: { default: { source: "env" as const } } } },
    surface,
    env: ambientAuth,
  };
}

const token = missingSecretRef("MISSING_LOCAL_TOKEN");
const password = missingSecretRef("MISSING_LOCAL_PASSWORD");
const remoteTokenRef = missingSecretRef("MISSING_REMOTE_TOKEN");
const remotePasswordRef = missingSecretRef("MISSING_REMOTE_PASSWORD");
const remoteToken = params({ remote: { token: remoteTokenRef } }, "remote");
const remotePassword = params({ remote: { password: remotePasswordRef } }, "remote");

it.each([
  ["local token mode", params({ auth: { mode: "token", token } }), "gateway.auth.token"],
  ["implicit local token mode", params({ auth: { token } }), "gateway.auth.token"],
  [
    "local password mode",
    params({ auth: { mode: "password", password } }),
    "gateway.auth.password",
  ],
  ["implicit local password mode", params({ auth: { password } }), "gateway.auth.password"],
  ["remote token", remoteToken, "gateway.remote.token"],
  ["remote password", remotePassword, "gateway.remote.password"],
] as const)(
  "keeps unavailable %s refs authoritative across probe and interactive surfaces",
  async (_label, request, path) => {
    const [probe, interactive] = await Promise.all([probeAuth(request), interactiveAuth(request)]);
    expect([probe.token, probe.password, probe.source]).toEqual([undefined, undefined, undefined]);
    expect(probe.diagnostics).toEqual([expect.stringContaining(`${path} SecretRef is unresolved`)]);
    expect([interactive.token, interactive.password]).toEqual([undefined, undefined]);
    expect(interactive.failureReason).toContain(`${path} SecretRef is unresolved`);
  },
);

it("preserves a healthy configured remote password when its sibling token ref fails", async () => {
  const request = params(
    {
      remote: {
        token: remoteTokenRef,
        password: "configured-password", // pragma: allowlist secret
      },
    },
    "remote",
  );
  await expect(interactiveAuth(request)).resolves.toEqual({
    token: undefined,
    password: "configured-password", // pragma: allowlist secret
  });
});

it.each([
  { mode: "password", inactiveCredential: "token" },
  { mode: "token", inactiveCredential: "password" },
] as const)(
  "ignores an unavailable $inactiveCredential ref when explicit $mode mode selects its sibling",
  async ({ mode, inactiveCredential }) => {
    const request = params({
      auth: {
        mode,
        [mode]: `configured-${mode}`,
        [inactiveCredential]: missingSecretRef("MISSING_INACTIVE_CREDENTIAL"),
      },
    });
    await expect(probeAuth(request)).resolves.toEqual({
      [mode]: `configured-${mode}`,
      source: "config",
    });
  },
);

it.each([
  ["remote token", remoteToken, "token", "explicit-token"],
  [
    "local password overriding token mode",
    params({ auth: { mode: "token", token } }),
    "password",
    "explicit-password",
  ], // pragma: allowlist secret
] as const)(
  "keeps explicit %s authoritative over unavailable configured refs",
  async (_name, request, kind, value) => {
    await expect(interactiveAuth({ ...request, explicitAuth: { [kind]: value } })).resolves.toEqual(
      { token: undefined, password: undefined, [kind]: value },
    );
  },
);

it("keeps a resolved remote password ref ahead of ambient password", async () => {
  await expect(
    interactiveAuth({
      ...remotePassword,
      env: { ...ambientAuth, MISSING_REMOTE_PASSWORD: "resolved-remote-password" },
    }),
  ).resolves.toEqual({ token: undefined, password: "resolved-remote-password" }); // pragma: allowlist secret
});
