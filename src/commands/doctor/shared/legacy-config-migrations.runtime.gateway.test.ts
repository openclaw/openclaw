import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObject } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw, pluginContracts: false });

it.each([
  { claws: true },
  { claws: false },
  { claws: true, templates: false },
  { claws: false, templates: true },
])("migrates the experimental Claws preference: %j", (preference) => {
  const experimental = { customPlugins: true, chatBubbles: true, ...preference };
  const raw = { gateway: { controlUi: { experimental } } };
  expect(validateConfigObject(raw).ok).toBe(false);
  expect(findLegacyConfigIssues(raw)).toContainEqual(
    expect.objectContaining({
      path: "gateway.controlUi.experimental.claws",
      message: expect.stringContaining("gateway.controlUi.experimental.templates"),
    }),
  );
  const result = migrate(raw);
  expect(result.next).toEqual({
    gateway: {
      controlUi: {
        experimental: {
          customPlugins: true,
          chatBubbles: true,
          templates: preference.templates ?? preference.claws,
        },
      },
    },
  });
  expect(result.changes).toHaveLength(1);
  expect(validateConfigObject(result.next).ok).toBe(true);
  expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  expect(raw.gateway.controlUi.experimental).toEqual({
    customPlugins: true,
    chatBubbles: true,
    ...preference,
  });
});

it("leaves public-origin inheritance out of persisted config", () => {
  expect(
    migrate({ gateway: { bind: "lan", publicOrigin: "https://gateway.example.com" } }),
  ).toEqual({ next: null, changes: [] });
});

it("removes even a false tool-title preference without changing other settings", () => {
  const raw = { gateway: { controlUi: { enabled: true, toolTitles: false } } };
  expect(findLegacyConfigIssues(raw)).toContainEqual(
    expect.objectContaining({
      path: "gateway.controlUi.toolTitles",
      message: expect.stringContaining("openclaw doctor --fix"),
    }),
  );
  expect(validateConfigObject(raw).ok).toBe(false);
  const result = migrate(raw);
  expect(result.next).toEqual({ gateway: { controlUi: { enabled: true } } });
  expect(result.changes).toHaveLength(1);
  expect(validateConfigObject(result.next).ok).toBe(true);
  expect(findLegacyConfigIssues(result.next)).toEqual([]);
  expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  expect(raw.gateway.controlUi.toolTitles).toBe(false);
});

it.each([false, undefined])(
  "preserves an empty Control UI owner after removing %j",
  (toolTitles) => {
    const result = migrate({ gateway: { controlUi: { toolTitles } } });
    expect(result.next).toEqual({ gateway: { controlUi: {} } });
    expect(result.changes).toEqual([
      "Removed retired gateway.controlUi.toolTitles; tool activity descriptions are automatic and make no utility-model calls.",
    ]);
  },
);
