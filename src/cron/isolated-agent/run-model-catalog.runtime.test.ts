import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPublishedPreparedModelCatalog: vi.fn(async () => [
    { id: "published", name: "Published", provider: "test" },
  ]),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPublishedPreparedModelCatalog: mocks.loadPublishedPreparedModelCatalog,
}));

import { loadPreparedModelCatalog } from "./run-model-catalog.runtime.js";

describe("cron model catalog runtime", () => {
  it("follows the committed prepared owner generation", async () => {
    const params = {
      agentDir: "/tmp/cron-model-catalog-agent",
      config: {},
      readOnly: true,
    };

    await expect(loadPreparedModelCatalog(params)).resolves.toEqual([
      { id: "published", name: "Published", provider: "test" },
    ]);
    expect(mocks.loadPublishedPreparedModelCatalog).toHaveBeenCalledWith(params);
  });
});
