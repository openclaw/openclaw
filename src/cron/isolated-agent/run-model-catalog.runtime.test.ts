import { describe, expect, it } from "vitest";
import { loadPublishedPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { loadPreparedModelCatalog } from "./run-model-catalog.runtime.js";

describe("cron model catalog runtime", () => {
  it("uses the committed prepared owner reader", () => {
    expect(loadPreparedModelCatalog).toBe(loadPublishedPreparedModelCatalog);
  });
});
