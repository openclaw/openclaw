import { expect, it } from "vitest";
import { materializePluginAutoEnableCandidates } from "./plugin-auto-enable.js";
import { makeRegistry } from "./plugin-auto-enable.test-helpers.js";
it("reads mixed-case plugin policy under the canonical lowercase key", () => {
  const ids = ["MyProv", "OtherProv", "OnProv"];
  const config = {
    plugins: {
      deny: ["otherprov"],
      entries: { myprov: { enabled: false }, onprov: { enabled: true } },
    },
  };
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates: ids.map((pluginId) => ({
      pluginId,
      kind: "provider-auth-configured" as const,
      providerId: pluginId.toLowerCase(),
    })),
    env: {},
    manifestRegistry: makeRegistry(ids.map((id) => ({ id, channels: [], origin: "global" }))),
  });
  expect(result.config).toEqual(config);
  expect(result.changes).toEqual([]);
});

function materialize(
  config: Parameters<typeof materializePluginAutoEnableCandidates>[0]["config"],
  id = "MyProv",
) {
  return materializePluginAutoEnableCandidates({
    config,
    env: {},
    candidates: [{ pluginId: id, kind: "provider-auth-configured", providerId: "myprov" }],
    manifestRegistry: makeRegistry([{ id, channels: [], origin: "global" }]),
  });
}
it.each([{ deny: ["MYPROV"] }, { entries: { MyPrOv: { enabled: false } } }])(
  "honors mixed-case raw deny and disable settings %j",
  (plugins) => {
    const config = { plugins };
    expect(materialize(config).config).toEqual(config);
    expect(materialize(config).changes).toEqual([]);
  },
);
it("does not duplicate an already allowed mixed-case plugin", () => {
  const config = { plugins: { allow: ["MYPROV"], entries: { myprov: { enabled: true } } } };
  expect(materialize(config).config).toEqual(config);
  expect(materialize(config).changes).toEqual([]);
});
it("writes a canonical enabled entry without dropping raw credentials", () => {
  const credentials = { config: { apiKey: "synthetic-key", env: { EXAMPLE: "synthetic-value" } } };
  const result = materialize({ plugins: { allow: ["other"], entries: { MyPrOv: credentials } } });
  expect(result.config.plugins?.allow).toEqual(["other", "myprov"]);
  expect(result.config.plugins?.entries).toEqual({
    MyPrOv: credentials,
    myprov: { enabled: true },
  });
});
it("adds material mixed-case raw entries to the allowlist without candidate discovery", () => {
  const credentials = { config: { apiKey: "synthetic-key", env: { EXAMPLE: "synthetic-value" } } };
  const result = materializePluginAutoEnableCandidates({
    config: { plugins: { allow: ["other"], entries: { MyProv: credentials } } },
    candidates: [],
    env: {},
    manifestRegistry: makeRegistry([{ id: "MyProv", channels: [], origin: "global" }]),
  });
  expect(result.config.plugins?.allow).toEqual(["other", "myprov"]);
  expect(result.config.plugins?.entries?.MyProv).toEqual(credentials);
});
