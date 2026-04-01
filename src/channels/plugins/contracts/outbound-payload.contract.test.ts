import { describe } from "vitest";
import {
  installDirectTextMediaOutboundPayloadContractSuite,
  installDiscordOutboundPayloadContractSuite,
  installSlackOutboundPayloadContractSuite,
  installWhatsAppOutboundPayloadContractSuite,
  installZaloOutboundPayloadContractSuite,
  installZalouserOutboundPayloadContractSuite,
} from "../../../test/helpers/channels/outbound-payload-contract.js";

describe("slack outbound payload contract", () => {
  installSlackOutboundPayloadContractSuite();
});

describe("discord outbound payload contract", () => {
  installDiscordOutboundPayloadContractSuite();
});

describe("whatsapp outbound payload contract", () => {
  installWhatsAppOutboundPayloadContractSuite();
});

describe("zalo outbound payload contract", () => {
  installZaloOutboundPayloadContractSuite();
});

describe("zalouser outbound payload contract", () => {
  installZalouserOutboundPayloadContractSuite();
});

describe("imessage outbound payload contract", () => {
  installDirectTextMediaOutboundPayloadContractSuite();
});
