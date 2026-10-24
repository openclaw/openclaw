import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withGatewayServiceUpdateAuthority } from "../daemon/service-update-authority.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { createTestConfigSnapshot } from "./test-runtime-config-helpers.js";

const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const { resolveGatewayAuthMock, defaultAuth } = vi.hoisted(() => {
  const auth = {
    mode: "token",
    token: undefined,
    password: undefined,
    allowTailscale: false,
  };
  return { defaultAuth: auth, resolveGatewayAuthMock: vi.fn(() => auth) };
});
const shouldRequireGatewayTokenForInstallMock = vi.hoisted(() => vi.fn(() => true));
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const secretRefKeyMock = vi.hoisted(() => vi.fn(() => "env:default:OPENCLAW_GATEWAY_TOKEN"));
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));

// mock-isolation: token installation must not write the operator's config.
vi.mock("../config/mutate.js", () => ({ replaceConfigFile: replaceConfigFileMock }));
// mock-isolation: exercise explicitly supplied auth outcomes without live credential resolution.
vi.mock("../gateway/auth.js", () => ({ resolveGatewayAuth: resolveGatewayAuthMock }));

vi.mock("../gateway/auth-install-policy.js", () => ({
  shouldRequireGatewayTokenForInstall: shouldRequireGatewayTokenForInstallMock,
}));

vi.mock("../secrets/ref-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/ref-contract.js")>()),
  secretRefKey: secretRefKeyMock,
}));

// mock-isolation: use fixture secret values without accessing real credential providers.
vi.mock("../secrets/resolve.js", () => ({ resolveSecretRefValues: resolveSecretRefValuesMock }));
// mock-isolation: generated tokens must be deterministic fixture values.
vi.mock("./random-token.js", () => ({ randomToken: randomTokenMock }));

function createGeneration(config: OpenClawConfig = {}) {
  const snapshot = {
    ...createTestConfigSnapshot(config),
    hash: "captured-config-hash",
  };
  return { snapshot, writeOptions: {} };
}

const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } as const;
function install(options: Partial<Parameters<typeof resolveGatewayInstallToken>[0]> = {}) {
  return resolveGatewayInstallToken({
    config: { gateway: { auth: { mode: "token" } } },
    env: {},
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSecretRefValuesMock.mockResolvedValue(new Map());
  shouldRequireGatewayTokenForInstallMock.mockReturnValue(true);
  resolveGatewayAuthMock.mockReturnValue(defaultAuth);
  randomTokenMock.mockReturnValue("generated-token");
});

it("does not generate or persist a token for SecretRef auth", async () => {
  resolveSecretRefValuesMock.mockResolvedValue(
    new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-token"]]),
  );
  const result = await install({
    config: { gateway: { auth: { mode: "token", token: tokenRef } } },
    env: { OPENCLAW_GATEWAY_TOKEN: "resolved-token" },
    generateIfMissing: createGeneration(),
  });
  expect(result).toMatchObject({
    unavailableReason: undefined,
    warnings: [expect.stringContaining("SecretRef-managed")],
  });
  expect(randomTokenMock).not.toHaveBeenCalled();
  expect(replaceConfigFileMock).not.toHaveBeenCalled();
});

it("returns unavailable reason when token SecretRef is unresolved in token mode", async () => {
  resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

  const result = await install({
    config: { gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } } },
  });

  expect(result.unavailableReason).toBe(
    "gateway.auth.token SecretRef is configured but unresolved (gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).).",
  );
});

it("returns unavailable reason when token and password are both configured and mode is unset", async () => {
  const auth = { token: "token-value", password: "password-value" }; // pragma: allowlist secret
  const result = await install({
    config: { gateway: { auth } },
    generateIfMissing: createGeneration(),
  });

  expect(result.unavailableReason).toContain("gateway.auth.mode is unset");
  expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode token");
  expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode password");
  expect(replaceConfigFileMock).not.toHaveBeenCalled();
  expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
});

it("persists an auto-generated token with the captured write guards", async () => {
  const generation = createGeneration();
  const baseSnapshot = generation.snapshot;
  const writeOptions = {
    expectedConfigPath: baseSnapshot.path,
    assertConfigPathForWrite: vi.fn(),
  };

  const result = await install({
    generateIfMissing: { ...generation, writeOptions },
  });

  expect(result.warnings.join("\n")).toContain("saving to config");
  expect(replaceConfigFileMock).toHaveBeenCalledOnce();
  expect(replaceConfigFileMock.mock.calls[0]?.[0]).toStrictEqual({
    sourceConfig: { gateway: { auth: { mode: "token", token: "generated-token" } } },
    snapshot: baseSnapshot,
    writeOptions: {
      baseSnapshot,
      ...writeOptions,
      skipRuntimeSnapshotRefresh: true,
    },
    afterWrite: { mode: "auto" },
  });
});

it("refuses an update-owned token commit after its captured precommit revokes authority", async () => {
  let current = true;
  let committed = false;
  replaceConfigFileMock.mockImplementationOnce(async (params) => {
    await params.writeOptions.beforeCommit?.();
    params.writeOptions.assertCurrent?.();
    committed = true;
  });
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("original owner revoked");
        }
      },
      () =>
        install({
          generateIfMissing: {
            ...createGeneration(),
            writeOptions: {
              beforeCommit: async () => {
                current = false;
              },
            },
          },
        }),
    ),
  ).rejects.toThrow("original owner revoked");
  expect(replaceConfigFileMock).toHaveBeenCalledOnce();
  expect(committed).toBe(false);
});

it("does not overwrite a SecretRef in the captured source config", async () => {
  const result = await install({
    generateIfMissing: createGeneration({
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    }),
  });

  expect(result.warnings.join("\n")).toContain("skipping plaintext token persistence");
  expect(replaceConfigFileMock).not.toHaveBeenCalled();
});

it("skips token SecretRef resolution when token auth is not required", async () => {
  shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);

  const result = await install({
    config: { gateway: { auth: { mode: "password", token: tokenRef } } },
  });

  expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
  expect(result.unavailableReason).toBeUndefined();
  expect(result.warnings).toStrictEqual([]);
});
