import { describeSessionBindingRegistryBackedContract } from "../../../../test/helpers/channels/session-binding-registry-backed-contract.js";
import { sessionBindingContractRegistry } from "./registry-session-binding.js";

for (const entry of sessionBindingContractRegistry) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
