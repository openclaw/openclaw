import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type DatabaseEngineSelection,
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { refResolutionError } from "../secrets/resolve-errors.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { GatewaySecretRefUnavailableError } from "./credentials.js";

const mocks = vi.hoisted(() => ({
  resolveDatabaseEngineSelection: vi.fn(),
}));

vi.mock("../infra/database-engine/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/config.js")>()),
  resolveDatabaseEngineSelection: mocks.resolveDatabaseEngineSelection,
}));

const storeMocks = vi.hoisted(() => ({
  sqliteToken: undefined as string | undefined,
  failure: undefined as Error | undefined,
}));

// PostgreSQL state holds "store-token"; the default SQLite store holds sqliteToken, if any.
vi.mock("../secrets/resolve-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/resolve-store.js")>()),
  resolveStoreRefs: async (params: { refs: Array<{ id: string }> }) => {
    if (storeMocks.failure) {
      throw storeMocks.failure;
    }
    const token =
      getDatabaseEngineSelection()?.effectiveEngines.state === "postgres"
        ? "store-token"
        : storeMocks.sqliteToken;
    return new Map(token ? params.refs.map((ref) => [ref.id, token]) : []);
  },
}));

const postgresSelection: DatabaseEngineSelection = Object.freeze({
  effectiveEngines: Object.freeze(
    resolveDatabaseFamilyEngines({ database: { families: { state: { engine: "postgres" } } } }),
  ),
  postgres: { connection: "postgresql://127.0.0.1/openclaw", schemaPrefix: "openclaw" },
});

const config = {
  gateway: {
    mode: "local",
    auth: {
      mode: "token",
      token: { source: "store", provider: "default", id: "GATEWAY_AUTH_TOKEN" },
    },
  },
  database: { families: { state: { engine: "postgres" } } },
} as OpenClawConfig;

afterEach(() => {
  mocks.resolveDatabaseEngineSelection.mockReset();
  storeMocks.sqliteToken = undefined;
  storeMocks.failure = undefined;
});

describe("resolveGatewayCredentialsWithSecretInputs store refs", () => {
  it("preserves the provider failure off the rendered cause chain of an unavailable store-backed token", async () => {
    const { providerResolutionError } = await import("../secrets/resolve-errors.js");
    // Resolution failures can quote payload-derived text: a malformed secret
    // file's JSON.parse error carries the file's raw bytes in its message.
    const payloadBytes = "violet meadow lantern";
    const failure = providerResolutionError({
      source: "store",
      provider: "default",
      message: `Secret store database is unavailable (near "${payloadBytes}")`,
    });
    storeMocks.failure = failure;

    let error: unknown;
    await resolveGatewayCredentialsWithSecretInputs({ config, env: {} }).catch((caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(GatewaySecretRefUnavailableError);
    const unavailable = error as GatewaySecretRefUnavailableError;
    // The failure stays reachable for explicit logging, but not on the standard
    // cause chain that the shared terminal formatter walks.
    expect(unavailable.providerFailure).toBe(failure);
    expect(unavailable.cause).toBeUndefined();
    expect(unavailable.message).toContain(
      "Provider error: SECRET_PROVIDER_UNAVAILABLE (source store, provider default)",
    );
    // A provider failure replaces the credential-override advice with provider
    // recovery guidance.
    expect(unavailable.message).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(unavailable.message).toContain("restore access to the secret provider and retry");
    // The shipped terminal rendering must not disclose the payload-derived text.
    expect(formatErrorMessage(unavailable)).not.toContain(payloadBytes);
    expect(formatErrorMessage(unavailable)).not.toContain("Secret store database is unavailable");
  });

  it("keeps reference-repair guidance for a ref-level not-found failure with an available provider", async () => {
    const failure = refResolutionError({
      code: "SECRET_REF_NOT_FOUND",
      source: "store",
      provider: "default",
      refId: "GATEWAY_AUTH_TOKEN",
      message: "Secret ref GATEWAY_AUTH_TOKEN was not found in the store",
    });
    storeMocks.failure = failure;

    let error: unknown;
    await resolveGatewayCredentialsWithSecretInputs({ config, env: {} }).catch((caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(GatewaySecretRefUnavailableError);
    const unavailable = error as GatewaySecretRefUnavailableError;
    expect(unavailable.providerFailure).toBe(failure);
    expect(unavailable.message).toContain(
      "Provider error: SECRET_REF_NOT_FOUND (source store, provider default)",
    );
    expect(unavailable.message).toContain("repair the configured secret reference");
    expect(unavailable.message).not.toContain("restore access to the secret provider");
  });

  it("keeps reference-repair guidance for a ref-level invalid failure", async () => {
    const failure = refResolutionError({
      code: "SECRET_REF_INVALID",
      source: "store",
      provider: "default",
      refId: "GATEWAY_AUTH_TOKEN",
      message: "Secret ref GATEWAY_AUTH_TOKEN is invalid",
    });
    storeMocks.failure = failure;

    let error: unknown;
    await resolveGatewayCredentialsWithSecretInputs({ config, env: {} }).catch((caught) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(GatewaySecretRefUnavailableError);
    const unavailable = error as GatewaySecretRefUnavailableError;
    expect(unavailable.providerFailure).toBe(failure);
    expect(unavailable.message).toContain(
      "Provider error: SECRET_REF_INVALID (source store, provider default)",
    );
    expect(unavailable.message).toContain("repair the configured secret reference");
    expect(unavailable.message).not.toContain("restore access to the secret provider");
  });
  it("reads store refs from the configured engine when the process has none selected", async () => {
    mocks.resolveDatabaseEngineSelection.mockResolvedValue(postgresSelection);
    const env = { OPENCLAW_GATEWAY_TOKEN: "env-token" };

    await expect(resolveGatewayCredentialsWithSecretInputs({ config, env })).resolves.toEqual({
      token: "store-token",
      password: undefined,
    });
    expect(mocks.resolveDatabaseEngineSelection).toHaveBeenCalledWith(
      expect.objectContaining({ database: config.database }),
      env,
    );
    expect(getDatabaseEngineSelection()).toBeUndefined();
  });

  it("reads SQLite state directly when only another family uses PostgreSQL", async () => {
    mocks.resolveDatabaseEngineSelection.mockRejectedValue(new Error("DSN env ref unavailable"));
    storeMocks.sqliteToken = "sqlite-token";
    const mixed = {
      ...config,
      database: {
        postgres: { connection: { source: "env", provider: "default", id: "SERVICE_ONLY_DSN" } },
        families: { state: { engine: "sqlite" }, workboard: { engine: "postgres" } },
      },
    } as OpenClawConfig;

    await expect(
      resolveGatewayCredentialsWithSecretInputs({ config: mixed, env: {} }),
    ).resolves.toEqual({ token: "sqlite-token", password: undefined });
    expect(mocks.resolveDatabaseEngineSelection).not.toHaveBeenCalled();
  });

  it("keeps the selection a process already owns", async () => {
    await expect(
      withDatabaseEngineSelection(postgresSelection, () =>
        resolveGatewayCredentialsWithSecretInputs({ config, env: {} }),
      ),
    ).resolves.toEqual({ token: "store-token", password: undefined });
    expect(mocks.resolveDatabaseEngineSelection).not.toHaveBeenCalled();
  });

  it("reports the ref unavailable when the configured engine cannot be selected", async () => {
    mocks.resolveDatabaseEngineSelection.mockRejectedValue(new Error("DSN file missing"));

    const result = resolveGatewayCredentialsWithSecretInputs({ config, env: {} });
    await expect(result).rejects.toBeInstanceOf(GatewaySecretRefUnavailableError);
    await expect(result).rejects.toThrow("gateway.auth.token");
  });
});
