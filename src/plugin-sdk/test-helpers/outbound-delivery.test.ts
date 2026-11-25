import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry as createOwnedEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createEmptyPluginRegistry } from "./outbound-delivery.js";

// mock-isolation: Importing the real registry would defeat the eager-registration boundary check.
vi.mock("../../plugins/registry.js", () => {
  throw new Error("Outbound test helpers must not load plugin registration.");
});

it("exports the empty registry owner without loading plugin registration", () => {
  expect(createEmptyPluginRegistry).toBe(createOwnedEmptyPluginRegistry);
});
