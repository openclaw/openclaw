// Cron heartbeat policy tests cover heartbeat status classification.
import { describe, expect, it } from "vitest";
import { shouldSkipHeartbeatOnlyDelivery } from "./heartbeat-policy.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("suppresses empty payloads", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([], 300)).toBe(true);
  });

  it("suppresses when the final text payload is a heartbeat ack", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "Checked inbox and calendar." }, { text: "HEARTBEAT_OK" }],
        300,
      ),
    ).toBe(true);
  });

  it("does not suppress a report emitted after an earlier heartbeat ack", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "HEARTBEAT_OK" }, { text: "An urgent calendar conflict needs attention." }],
        300,
      ),
    ).toBe(false);
  });

  it("ignores empty text payloads after the terminal heartbeat ack", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([{ text: "HEARTBEAT_OK" }, { text: "  " }], 300)).toBe(
      true,
    );
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
