import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { PluginEntrySchema } from "../../../config/zod-schema.root-support.js";
import { resolvePromptInjectionAllowed } from "../../../plugins/hook-policy-decisions.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

function migrate(hooks: Record<string, unknown>) {
  const raw = { plugins: { entries: { "example.with.dots": { hooks } } } };
  const next = structuredClone(raw);
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  return { raw, next, hooks: next.plugins.entries["example.with.dots"].hooks, changes };
}

it.each([true, false])(
  "migrates the registered prompt grant %s without changing its meaning",
  (value) => {
    const { raw, next, hooks, changes } = migrate({ allowPromptInjection: value, timeoutMs: 1234 });
    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "plugins.entries",
      message: expect.stringContaining("allowPromptModification"),
    });
    expect(hooks).toEqual({ allowPromptModification: value, timeoutMs: 1234 });
    expect(
      resolvePromptInjectionAllowed(
        PluginEntrySchema.parse(next.plugins.entries["example.with.dots"]).hooks,
      ),
    ).toBe(value);
    expect(changes).toHaveLength(1);
    expect(raw.plugins.entries["example.with.dots"].hooks).toHaveProperty(
      "allowPromptInjection",
      value,
    );
    expect(migrate(hooks).changes).toEqual([]);
    expect(migrate({ allowPromptInjection: value, allowPromptModification: value }).hooks).toEqual({
      allowPromptModification: value,
    });
  },
);

it.each([
  { allowPromptInjection: false, allowPromptModification: true },
  { allowPromptInjection: true, allowPromptModification: false },
  { allowPromptInjection: "false" },
  { allowPromptInjection: null },
  { allowPromptInjection: false, allowPromptModification: "true" },
])("refuses conflicting or malformed grants without guessing: %j", (hooks) => {
  expect(() => migrate(hooks)).toThrow(/Cannot migrate plugins.entries.example.with.dots.hooks/);
});

it.each([
  { allowPromptModification: "no", allowConversationAccess: true },
  { allowPromptModification: false, allowConversationAccess: "yes" },
])("rejects invalid current-format hook booleans: %j", (hooks) => {
  expect(PluginEntrySchema.safeParse({ hooks }).success).toBe(false);
});

it("leaves an unset grant and other hook settings alone", () => {
  const { raw, next, hooks, changes } = migrate({ allowConversationAccess: false });
  expect(next).toEqual(raw);
  expect(changes).toEqual([]);
  expect(
    resolvePromptInjectionAllowed(
      PluginEntrySchema.parse(next.plugins.entries["example.with.dots"]).hooks,
    ),
  ).toBe(true);
  expect(hooks).not.toHaveProperty("allowPromptModification");
  expect(findLegacyConfigIssues(next)).toEqual([]);
});
