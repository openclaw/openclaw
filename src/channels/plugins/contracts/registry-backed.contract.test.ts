import {
  describeChannelRegistryBackedContracts,
  describeSessionBindingRegistryBackedContract,
} from "../../../../test/helpers/channels/registry-backed-contract.js";
import {
  actionContractRegistry,
  directoryContractRegistry,
  pluginContractRegistry,
  sessionBindingContractRegistry,
  setupContractRegistry,
  statusContractRegistry,
  surfaceContractRegistry,
  threadingContractRegistry,
} from "./registry.js";

const registryIds = new Set<string>([
  ...pluginContractRegistry.map((entry) => entry.id),
  ...actionContractRegistry.map((entry) => entry.id),
  ...setupContractRegistry.map((entry) => entry.id),
  ...statusContractRegistry.map((entry) => entry.id),
  ...surfaceContractRegistry.map((entry) => entry.id),
  ...threadingContractRegistry.map((entry) => entry.id),
  ...directoryContractRegistry.map((entry) => entry.id),
]);

for (const id of [...registryIds].toSorted()) {
  describeChannelRegistryBackedContracts(id);
}

for (const entry of sessionBindingContractRegistry) {
  describeSessionBindingRegistryBackedContract(entry.id);
}
