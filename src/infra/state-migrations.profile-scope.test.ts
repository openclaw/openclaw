import path from "node:path";
import { expect, it } from "vitest";
import { resolveLegacyProfileMigrationExceptions } from "./state-migrations.profile-scope.js";

it("uses supplied OS home without adopting another OpenClaw home", () => {
  const home = path.resolve("supplied-home");
  const agent = path.join(home, ".openclaw", "agent");
  expect(
    resolveLegacyProfileMigrationExceptions({
      env: { HOME: home },
      homedir: () => path.resolve("stale-home"),
    }).standaloneAgent,
  ).toBe(agent);
  expect(
    resolveLegacyProfileMigrationExceptions({
      env: { HOME: home, OPENCLAW_HOME: path.resolve("other-home") },
      homedir: () => path.resolve("stale-home"),
    }).standaloneAgent,
  ).toBeUndefined();
});
