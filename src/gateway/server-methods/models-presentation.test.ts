import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listModels } from "./models-list.test-support.js";

describe("models.list provider presentation", () => {
  it("publishes authored mixed-case provider presentation without changing identity or leaking sources", async () => {
    await withOpenClawTestState({ prefix: "models-presentation-", scenario: "empty" }, async () => {
      const loadGatewayModelCatalog = vi.fn(async () => [
        { id: "local-model", name: "Local model", provider: "workstation" },
      ]);
      for (const [name, icon] of [
        ["Workstation", { source: "file", path: "/private/icons/workstation.png" }],
        ["Studio", { source: "url", url: "https://images.example.com/studio.png" }],
        ["Studio server", { source: "builtin", name: "server" }],
      ] as const) {
        const respond = await listModels({
          view: "all",
          loadGatewayModelCatalog,
          runtimeConfig: {
            models: {
              providers: {
                " Workstation ": {
                  baseUrl: "https://models.example.com/v1",
                  auth: "none",
                  models: [],
                  name,
                  icon,
                },
                hidden: {
                  baseUrl: "https://hidden.example.com/v1",
                  models: [],
                  name: "Hidden provider",
                },
              },
            },
          },
        });
        const payload = respond.mock.calls[0]?.[1];
        expect(payload).toMatchObject({
          models: [
            {
              id: "local-model",
              name: "Local model",
              provider: "workstation",
              providerName: name,
              providerIcon:
                icon.source === "builtin" ? icon : { source: "asset", url: expect.any(String) },
            },
          ],
          providerPresentations: { workstation: { providerName: name } },
        });
        expect(JSON.stringify(payload)).not.toContain("/private/icons");
        expect(JSON.stringify(payload)).not.toContain("images.example.com");
        expect(JSON.stringify(payload)).not.toContain("Hidden provider");
      }
      const configured = {
        loadGatewayModelCatalog: vi.fn(async () => []),
        runtimeConfig: {
          models: {
            providers: {
              workstation: {
                baseUrl: "https://models.example.com/v1",
                models: [],
                name: "Workstation",
                icon: { source: "builtin", name: "server" },
              },
            },
          },
        },
      } satisfies Parameters<typeof listModels>[0];
      for (const view of [undefined, "default", "configured", "provider-config"] as const) {
        const settings = await listModels({ ...configured, view });
        expect(settings.mock.calls[0]?.[1]).toMatchObject({
          models: [],
          providerPresentations: {
            workstation: {
              providerName: "Workstation",
              providerIcon: { source: "builtin", name: "server" },
            },
          },
        });
      }
      for (const filter of [
        { view: "all" },
        { view: "configured", provider: "workstation" },
        { view: "provider-config", provider: "workstation" },
        { view: "configured", sessionKey: "agent:main:provider-presentation" },
      ] as const) {
        const filtered = await listModels({ ...configured, ...filter });
        expect(filtered.mock.calls[0]?.[0]).toBe(true);
        expect(filtered.mock.calls[0]?.[1]).not.toHaveProperty("providerPresentations");
      }
    });
  });
});
