// Session binding registry contract tests cover channel session binding across registry fixtures.
import { expect, it } from "vitest";
import {
  describeSessionBindingRegistryBackedContract,
  getSessionBindingContractRegistry,
} from "./test-helpers/registry-session-binding.js";

const entries = getSessionBindingContractRegistry();

it("exercises the Discord and Telegram session-binding adapters", () => {
  expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(["discord", "telegram"]));
});

for (const entry of entries) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
