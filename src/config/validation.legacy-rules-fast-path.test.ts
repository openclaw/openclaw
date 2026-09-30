import { expect, it, vi } from "vitest";
import type { LegacyConfigRule } from "./legacy.shared.js";

const { channelRules, doctorRules, metadata } = vi.hoisted(() => ({
  channelRules: vi.fn((): LegacyConfigRule[] => [
    { path: ["channels", "discord", "legacy"], message: "legacy discord key" },
  ]),
  doctorRules: vi.fn((): LegacyConfigRule[] => []),
  metadata: vi.fn(() => ({ manifestRegistry: { diagnostics: [], plugins: [] }, plugins: [] })),
}));

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: channelRules,
}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({
  listPluginDoctorLegacyConfigRules: doctorRules,
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: metadata,
}));

import { validateConfigObjectRaw } from "./validation.js";

it("validates raw config without loading channel, doctor, or plugin metadata", () => {
  expect(validateConfigObjectRaw({ channels: { discord: {} } }).ok).toBe(true);
  expect(channelRules).not.toHaveBeenCalled();
  expect(doctorRules).not.toHaveBeenCalled();
  expect(metadata).not.toHaveBeenCalled();
});
