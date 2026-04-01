import { describe } from "vitest";
import {
  installDiscordInboundContractSuite,
  installSignalInboundContractSuite,
  installSlackInboundContractSuite,
  installTelegramInboundContractSuite,
  installWhatsAppInboundContractSuite,
} from "../../../../test/helpers/channels/inbound-contract.js";

describe("discord inbound contract", () => {
  installDiscordInboundContractSuite();
});

describe("signal inbound contract", () => {
  installSignalInboundContractSuite();
});

describe("slack inbound contract", () => {
  installSlackInboundContractSuite();
});

describe("telegram inbound contract", () => {
  installTelegramInboundContractSuite();
});

describe("whatsapp inbound contract", () => {
  installWhatsAppInboundContractSuite();
});
