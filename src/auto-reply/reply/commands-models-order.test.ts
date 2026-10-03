import { expect, it, vi } from "vitest";
import { resolveModelsCommandReply } from "./commands-models.js";

vi.mock("./commands-models-catalog.js", () => ({
  loadModelsProviderData: async () => ({
    byProvider: new Map([
      [
        "fixture",
        new Set([
          "z-curated",
          ...Array.from({ length: 298 }, (_, index) => `model-${String(index).padStart(3, "0")}`),
          "z-current",
        ]),
      ],
    ]),
    providers: ["fixture"],
    resolvedDefault: { provider: "fixture", model: "z-curated" },
    modelNames: new Map(),
    modelCatalog: [],
  }),
}));
vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => undefined,
}));
vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
}));

it("keeps the current and curated choices on the first text-channel page without losing later models", async () => {
  const params = {
    cfg: {},
    surface: "slack",
    currentModel: "fixture/z-current",
    commandBodyNormalized: "/models fixture",
  };
  const first = await resolveModelsCommandReply(params);
  const rows = [...(first?.text ?? "").matchAll(/^- fixture\/(.+)$/gm)].map((match) => match[1]);
  expect(rows.slice(0, 3)).toEqual(["z-current", "z-curated", "model-000"]);
  expect(rows).toHaveLength(20);
  const last = await resolveModelsCommandReply({
    ...params,
    commandBodyNormalized: "/models fixture 15",
  });
  expect(last?.text).toContain("- fixture/model-297");
});
