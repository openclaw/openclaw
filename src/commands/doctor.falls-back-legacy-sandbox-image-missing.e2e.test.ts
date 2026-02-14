import { describe, expect, it } from "vitest";
import { arrangeLegacyStateMigrationTest, confirm } from "./doctor.e2e-harness.js";

describe("doctor command", () => {
  it("runs legacy state migrations in non-interactive mode without prompting", async () => {
    const { doctorCommand, runtime, runLegacyStateMigrations } =
      await arrangeLegacyStateMigrationTest();

    await doctorCommand(runtime, { nonInteractive: true });

    expect(runLegacyStateMigrations).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  }, 30_000);
});
