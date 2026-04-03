import { describe } from "vitest";
import { installSlackInboundContractSuite } from "../../../../test/helpers/channels/inbound-contract.slack.js";

describe("slack inbound contract", () => {
  installSlackInboundContractSuite();
});
