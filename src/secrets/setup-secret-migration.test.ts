import { expect, it, vi } from "vitest";
import { inspectSetupSecretMigration } from "./setup-secret-migration.js";

const store = vi.hoisted(() => ({
  load: vi.fn(),
  read: vi.fn<typeof import("./store/secret-store.js").readSelectedSecretStoreEntries>(
    async () => [],
  ),
}));

vi.mock("./store/secret-store.js", async (importOriginal) => {
  store.load();
  return {
    ...(await importOriginal<typeof import("./store/secret-store.js")>()),
    readSelectedSecretStoreEntries: store.read,
  };
});

it("does not load or read the secret store without selectable migration names", async () => {
  expect(await inspectSetupSecretMigration({ names: [], env: {} })).toEqual([]);
  expect(await inspectSetupSecretMigration({ names: ["lower_token"], env: {} })).toEqual([
    { name: "lower_token", status: "missing" },
  ]);
  expect(store.load).not.toHaveBeenCalled();
  expect(store.read).not.toHaveBeenCalled();
});
