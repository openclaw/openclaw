// Session binding registry contract tests cover channel session binding across registry fixtures.
import {
  describeSessionBindingRegistryBackedContract,
  getSessionBindingContractRegistry,
} from "./test-helpers/registry-session-binding.js";

for (const entry of getSessionBindingContractRegistry()) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
