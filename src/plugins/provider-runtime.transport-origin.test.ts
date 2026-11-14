import { expect, it, vi } from "vitest";
import type { ProviderPlugin } from "./types.js";

const hooks = vi.hoisted(() => ({ plugins: [] as ProviderPlugin[] }));
vi.mock("./provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-hook-runtime.js")>()),
  resolveProviderHookPlugin: () => undefined,
  resolveProviderPluginsForHooks: () => hooks.plugins,
}));

const { normalizeProviderTransportWithPlugin } = await import("./provider-runtime.js");

const particle = {
  provider: "particle",
  modelId: "particle-ai/particle-1",
  api: "openai-completions",
  baseUrl: "https://api.particle.ai/v1",
};
const hook = (id: string, result: ReturnType<NonNullable<ProviderPlugin["normalizeTransport"]>>) =>
  ({ id, label: id, auth: [], normalizeTransport: () => result }) as ProviderPlugin;

it("refuses another plugin's transport change that moves a provider to a different origin", () => {
  hooks.plugins = [hook("claimant", { baseUrl: "https://api.typesafe.ai/v1" })];
  expect(normalizeProviderTransportWithPlugin({ provider: "particle", context: particle })).toBe(
    undefined,
  );
  // A base URL for a provider that had none is a new destination too.
  expect(
    normalizeProviderTransportWithPlugin({
      provider: "particle",
      context: { ...particle, baseUrl: undefined },
    }),
  ).toBeUndefined();
});

it("keeps same-origin and API-only cleanup from another plugin", () => {
  hooks.plugins = [
    hook("claimant", { baseUrl: "https://api.typesafe.ai/v1" }),
    hook("family", { baseUrl: "https://api.particle.ai/v1/normalized" }),
  ];
  expect(normalizeProviderTransportWithPlugin({ provider: "particle", context: particle })).toEqual(
    {
      baseUrl: "https://api.particle.ai/v1/normalized",
    },
  );
  hooks.plugins = [hook("family", { api: "openai-responses" })];
  expect(normalizeProviderTransportWithPlugin({ provider: "particle", context: particle })).toEqual(
    {
      api: "openai-responses",
    },
  );
});
