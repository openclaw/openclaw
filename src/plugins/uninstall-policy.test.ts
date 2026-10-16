import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareConfigForDisabledPluginSet } from "./uninstall-package-plan.js";
import { planPluginUninstall } from "./uninstall.js";

it("disables only runtime child entries for a package uninstall", () => {
  const staged = prepareConfigForDisabledPluginSet(
    {
      plugins: {
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: true },
        },
      },
    },
    ["pack/one", "pack/two"],
  );

  expect(staged.plugins?.entries).toEqual({
    "pack/one": { enabled: false },
    "pack/two": { enabled: false },
  });
  expect(staged.plugins?.entries).not.toHaveProperty("pack");
});

it("removes mixed-case plugin policy while keeping the exact install owner", () => {
  const config: OpenClawConfig = {
    plugins: {
      entries: {
        "mixed-demo": { enabled: true, config: { label: "remove" } },
        "MiXeD-demo": { config: { legacy: true } },
        other: { enabled: true },
      },
      allow: ["MIXED-demo", "other"],
      deny: ["Mixed-DEMO"],
      installs: { "MiXeD-demo": { source: "path", sourcePath: "/plugins/example" } },
    },
  };
  const staged = prepareConfigForDisabledPluginSet(config, ["MiXeD-demo"]);
  expect.soft(staged.plugins?.entries).toEqual({
    "mixed-demo": { enabled: false, config: { label: "remove", legacy: true } },
    other: { enabled: true },
  });
  expect(staged.plugins?.installs).toEqual(config.plugins?.installs);

  const plan = planPluginUninstall({
    config: staged,
    pluginId: "MiXeD-demo",
    channelIds: [],
    deleteFiles: false,
  });
  if (!plan.ok) {
    throw new Error(plan.error);
  }
  expect(plan.config.plugins).toEqual({
    entries: { "mixed-demo": { enabled: false }, other: { enabled: true } },
    allow: ["other"],
  });
  expect(plan.actions).toMatchObject({
    entry: true,
    install: true,
    allowlist: true,
    denylist: true,
  });
});
