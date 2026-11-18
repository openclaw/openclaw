import { describe, expect, it } from "vitest";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";

const migration = {
  id: "legacy-state",
  label: "Legacy state",
  detectLegacyState: () => null,
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
};

it("keeps recovery registration separate from automatic migrations", () => {
  const registerRecoveryCli = () => {};
  const contract = coercePluginDoctorContractModule({ registerRecoveryCli });
  expect(contract.registerRecoveryCli).toBe(registerRecoveryCli);
  expect(contract.summary.recoveryCli).toBe(true);
  expect(contract.stateMigrations).toEqual([]);
  expect(contract.summary.stateMigrations).toBe(false);
  expect(() => coercePluginDoctorContractModule({ registerRecoveryCli: true })).toThrow();
});

describe("SQLite-only Doctor declarations", () => {
  it("retains and normalizes the declared family and PostgreSQL notice", () => {
    const contract = coercePluginDoctorContractModule({
      stateMigrations: [
        { ...migration, sqliteOnly: { family: "agent", postgresNote: "  Rebuild the index.  " } },
        migration,
      ],
    });
    expect(contract.stateMigrations.map((entry) => entry.sqliteOnly)).toEqual([
      { family: "agent", postgresNote: "Rebuild the index." },
      undefined,
    ]);
  });

  it.each([
    null,
    true,
    {},
    { family: "unknown" },
    { family: "quarantine" },
    { family: "state", postgresNote: 1 },
    { family: "state", postgresNote: " " },
    { family: "state", typo: true },
  ])("rejects invalid SQLite-only metadata instead of running the migration: %j", (sqliteOnly) => {
    expect(() =>
      coercePluginDoctorContractModule({ stateMigrations: [{ ...migration, sqliteOnly }] }),
    ).toThrow();
  });
});
