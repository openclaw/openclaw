import { describe } from "vitest";
import { installTelegramInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.telegram.js";

describe("telegram inbound contract", () => {
  installTelegramInboundContractSuite();
});
