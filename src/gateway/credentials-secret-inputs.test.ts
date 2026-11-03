import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type DatabaseEngineSelection,
  getDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { GatewaySecretRefUnavailableError } from "./credentials.js";

const mocks = vi.hoisted(() => ({
  resolveDatabaseEngineSelection: vi.fn(),
}));

vi.mock("../infra/database-engine/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/database-engine/config.js")>()),
  resolveDatabaseEngineSelection: mocks.resolveDatabaseEngineSelection,
}));

const storeMocks = vi.hoisted(() => ({ sqliteToken: undefined as string | undefined }));

// PostgreSQL state holds "store-token"; the default SQLite store holds sqliteToken, if any.
vi.mock("../secrets/resolve-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/resolve-store.js")>()),
  resolveStoreRefs: async (params: { refs: Array<{ id: string }> }) => {
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
});

describe("resolveGatewayCredentialsWithSecretInputs store refs", () => {
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
