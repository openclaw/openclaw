import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { getCanonicalUserPreferences } from "../state/user-preferences.js";
import { prepareControlUiBootstrapPreferences } from "./control-ui-bootstrap-preferences.js";

// mock-isolation: the projection uses synthetic preferences without a Gateway/SQLite owner.
vi.mock("../state/user-preferences.js", () => ({
  getCanonicalUserPreferences: vi.fn(async () => ({ entries: { "ui.themeMode": "light" } })),
}));

it("includes only the viewer's presentation data and redacts MCP credentials", async () => {
  using jsonSchema = vi.spyOn(OpenClawSchema, "toJSONSchema");
  const config: OpenClawConfig = {
    ui: { prefs: { locale: "de" } },
    models: {
      providers: {
        fixture: {
          apiKey: "synthetic-provider-secret",
          baseUrl: "https://example.test",
          models: [],
        },
      },
    },
    mcp: {
      servers: {
        fixture: {
          url: "https://example.test/mcp?api_key=synthetic-mcp-secret",
          headers: { Authorization: "synthetic-header-secret" },
          env: { TOKEN: "synthetic-env-secret" },
        },
      },
    },
  };
  const bootstrap = await prepareControlUiBootstrapPreferences(config, {
    operatorScopes: ["operator.admin"],
    authenticatedUserProfile: {
      profileId: "synthetic-viewer",
      displayName: null,
      avatarRevision: "",
      hasAvatar: false,
      updatedAt: 0,
    },
  });
  expect(bootstrap).toMatchObject({
    profileId: "synthetic-viewer",
    config: { ui: { prefs: { locale: "de" } } },
    entries: { "ui.themeMode": "light" },
  });
  expect(getCanonicalUserPreferences).toHaveBeenCalledWith(
    "synthetic-viewer",
    expect.arrayContaining(["ui.themeMode", "ui.railShortcuts"]),
  );
  expect(JSON.stringify(bootstrap)).not.toMatch(/synthetic-(provider|mcp|header|env)-secret/);
  expect(jsonSchema).not.toHaveBeenCalled();
  const reader = await prepareControlUiBootstrapPreferences(config, {
    operatorScopes: ["operator.approvals"],
  });
  expect(reader?.config).toBeUndefined();
  expect(reader?.entries).toBeUndefined();
});
