import { it } from "vitest";

it("runs production announcement proofs against loopback Slack", async () => {
  await import("../../scripts/proof-announcement-native-progress-timeout.ts");
  await import("../../scripts/proof-announcement-delivery-live.ts");
  await import("../../scripts/proof-announcement-delivery-settlement.ts");
});
