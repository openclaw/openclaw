import { expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

function validateMapping(mapping: Record<string, unknown>) {
  return validateConfigObjectWithPlugins({
    agents: { entries: { openclaw: {} } },
    hooks: { mappings: [{ action: "agent", messageTemplate: "card update", ...mapping }] },
  });
}

it.each(["/tmp/transform.mjs", "../escape.mjs"])("rejects unsafe transform module %s", (module) => {
  expect(validateMapping({ transform: { module } })).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ path: "hooks.mappings.0.transform.module" }),
    ]),
  });
});

it("rejects retired hooks.internal.handlers registrations", () => {
  expect(
    validateConfigObjectWithPlugins({
      agents: { entries: { openclaw: {} } },
      hooks: {
        internal: {
          enabled: true,
          handlers: [{ event: "command:new", module: "hooks/handler.mjs" }],
        },
      },
    }),
  ).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({ path: "hooks.internal" })]),
  });
});

it("accepts persistent mappings with a transform-provided session key", () => {
  expect(
    validateMapping({ sessionMode: "persistent", transform: { module: "card-update.ts" } }).ok,
  ).toBe(true);
});

it("rejects persistent mappings without a stable session key source", () => {
  expect(validateMapping({ sessionMode: "persistent" })).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ path: "hooks.mappings.0.sessionKey" }),
    ]),
  });
});
