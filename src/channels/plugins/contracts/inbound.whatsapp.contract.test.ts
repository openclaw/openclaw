import { describe } from "vitest";
import { installWhatsAppInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.whatsapp.js";

describe("whatsapp inbound contract", () => {
  installWhatsAppInboundContractSuite();
});
