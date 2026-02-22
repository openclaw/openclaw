import { vi } from "vitest";

// Avoid dynamic-importing heavy readability deps in unit test suites.
vi.mock("./web-fetch-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./web-fetch-utils.js")>("./web-fetch-utils.js");
  return {
    ...actual,
    extractReadableContent: vi.fn().mockResolvedValue({
      title: "HTML Page",
      text: "HTML Page\n\nContent here.",
    }),
  };
});
