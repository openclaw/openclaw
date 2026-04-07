import { getSessionBindingContractRegistry } from "../../../../test/helpers/channels/registry-session-binding.js";
import { describeSessionBindingRegistryBackedContract } from "../../../../test/helpers/channels/session-binding-registry-backed-contract.js";

for (const entry of getSessionBindingContractRegistry()) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
