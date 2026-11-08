import { expect, it } from "vitest";
import { normalizeStoredQueueItem, sameQueuedDeliveryVersion } from "./outbox-store-codec.ts";

it("recovers the submitted App context and distinguishes changed queued attachments", () => {
  const appContext = [
    {
      title: "Helmet shell",
      uri: "shell://specimens/helmet",
      description: "Shared facts",
      icon: "https://example.test/shell.png",
    },
  ];
  const row = { id: "app-receipt", text: "Describe it", createdAt: 123, appContext };
  const restored = normalizeStoredQueueItem(structuredClone(row));
  expect(restored?.appContext).toEqual(appContext);
  expect(sameQueuedDeliveryVersion({ ...restored!, appContext }, restored!)).toBe(true);
  expect(sameQueuedDeliveryVersion(row, { ...row, appContext: [{ title: "Clam" }] })).toBe(false);
});
