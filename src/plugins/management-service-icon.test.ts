import { describe, expect, it, vi } from "vitest";
import { resolveManagedSetupCatalogIconUrl } from "./management-service.js";

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: () => [],
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: () => [],
}));

describe("managed ClawHub skill icon URLs", () => {
  it.each([
    {
      label: "the default ClawHub registry",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      allowed: true,
    },
    {
      label: "a configured ClawHub registry",
      env: { OPENCLAW_CLAWHUB_URL: "https://registry.example.test" },
      iconUrl: `https://registry.example.test/api/v1/skill-icons/${"b".repeat(64)}`,
      allowed: true,
    },
    {
      label: "a path-mounted ClawHub registry",
      env: { OPENCLAW_CLAWHUB_URL: "https://registry.example.test/clawhub/" },
      iconUrl: `https://registry.example.test/clawhub/api/v1/skill-icons/${"b".repeat(64)}`,
      allowed: true,
    },
    {
      label: "an icon outside the configured registry path",
      env: { OPENCLAW_CLAWHUB_URL: "https://registry.example.test/clawhub" },
      iconUrl: `https://registry.example.test/api/v1/skill-icons/${"b".repeat(64)}`,
      allowed: false,
    },
    {
      label: "the fallback ClawHub registry setting",
      env: { CLAWHUB_URL: "https://registry.example.test" },
      iconUrl: `https://registry.example.test/api/v1/skill-icons/${"c".repeat(64)}`,
      allowed: true,
    },
    {
      label: "an untrusted registry origin",
      env: { OPENCLAW_CLAWHUB_URL: "https://registry.example.test" },
      iconUrl: `https://attacker.example.test/api/v1/skill-icons/${"a".repeat(64)}`,
      allowed: false,
    },
    {
      label: "a query string",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}?redirect=1`,
      allowed: false,
    },
    {
      label: "a URL fragment",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}#redirect`,
      allowed: false,
    },
    {
      label: "an uppercase icon digest",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"A".repeat(64)}`,
      allowed: false,
    },
    {
      label: "a non-icon API path",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/packages/${"a".repeat(64)}`,
      allowed: false,
    },
    {
      label: "registry URL credentials",
      env: { OPENCLAW_CLAWHUB_URL: "https://user:secret@clawhub.ai" },
      iconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      allowed: false,
    },
    {
      label: "icon URL credentials",
      env: { OPENCLAW_CLAWHUB_URL: "https://clawhub.ai" },
      iconUrl: `https://user:secret@clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
      allowed: false,
    },
    {
      label: "an insecure registry origin",
      env: { OPENCLAW_CLAWHUB_URL: "http://registry.example.test" },
      iconUrl: `https://registry.example.test/api/v1/skill-icons/${"a".repeat(64)}`,
      allowed: false,
    },
  ])("pins ClawHub skill icons to $label", ({ env, iconUrl, allowed }) => {
    expect(resolveManagedSetupCatalogIconUrl({ config: {}, env, iconUrl })).toBe(
      allowed ? iconUrl : undefined,
    );
  });
});
