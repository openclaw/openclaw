import { describeSessionBindingRegistryBackedContract } from "../../../../test/helpers/channels/session-binding-registry-backed-contract.js";
import { getSessionBindingContractRegistry } from "./registry-session-binding.js";

for (const entry of getSessionBindingContractRegistry()) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
