// Cron heartbeat policy tests cover heartbeat status classification.
import { describe, expect, it } from "vitest";
import { shouldSkipHeartbeatOnlyDelivery } from "./heartbeat-policy.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("suppresses empty payloads", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([], 300)).toBe(true);
  });

  it("does not suppress when mixed with real content and heartbeat ack", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "Checked inbox and calendar." }, { text: "HEARTBEAT_OK" }],
        300,
      ),
    ).toBe(false);
  });

  it("suppresses when all payloads are heartbeat acks", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery([{ text: "HEARTBEAT_OK" }, { text: "HEARTBEAT_OK" }], 300),
    ).toBe(true);
  });

  it("does not suppress when media is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/image.png" }],
        300,
      ),
    ).toBe(false);
  });

  it("does not suppress when rich content is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [
          {
            text: "HEARTBEAT_OK",
            presentation: {
              blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
            },
          },
        ],
        300,
      ),
    ).toBe(false);
  });
});
