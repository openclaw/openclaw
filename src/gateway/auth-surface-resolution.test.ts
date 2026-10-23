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

function missingSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function params(
  gateway: NonNullable<OpenClawConfig["gateway"]>,
  surface: "local" | "remote" = "local",
  env = ambientAuth,
) {
  const config: OpenClawConfig = {
    gateway,
    secrets: { providers: { default: { source: "env" } } },
  };
  return { config, surface, env };
}

const token = missingSecretRef("MISSING_LOCAL_TOKEN");
const password = missingSecretRef("MISSING_LOCAL_PASSWORD");
const remoteToken = params(
  { remote: { token: missingSecretRef("MISSING_REMOTE_TOKEN") } },
  "remote",
);
const remotePassword = params(
  { remote: { password: missingSecretRef("MISSING_REMOTE_PASSWORD") } },
  "remote",
);

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
        token: missingSecretRef("MISSING_REMOTE_TOKEN"),
        password: "configured-password", // pragma: allowlist secret
      },
    },
    "remote",
  );
  const [probe, interactive] = await Promise.all([probeAuth(request), interactiveAuth(request)]);

  expect(probe).toEqual({
    token: undefined,
    password: "configured-password", // pragma: allowlist secret
    source: "config",
    diagnostics: [expect.stringContaining("gateway.remote.token SecretRef is unresolved")],
  });
  expect(interactive).toEqual({
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
    await expect(
      probeAuth(
        params({
          auth: {
            mode,
            [mode]: `configured-${mode}`,
            [inactiveCredential]: missingSecretRef("MISSING_INACTIVE_CREDENTIAL"),
          },
        }),
      ),
    ).resolves.toEqual({ [mode]: `configured-${mode}`, source: "config" });
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
      {
        token: kind === "token" ? value : undefined,
        password: kind === "password" ? value : undefined,
      },
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
