import { describe } from "vitest";
import { installDiscordInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.js";

describe("discord inbound contract", () => {
  installDiscordInboundContractSuite();
});
