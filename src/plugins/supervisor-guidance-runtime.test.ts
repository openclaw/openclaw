import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertGatewayServiceMutationAllowed,
  formatExternalSupervisorActionRequired,
} from "../infra/gateway-supervision.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { resolveExternalSupervisorGuidance } from "./supervisor-guidance-runtime.js";

let home: TempHomeEnv;
let config: OpenClawConfig;
const guidance = {
  version: 1,
  name: "Deployment manager",
  runFrom: "Deployment host",
  actions: {
    start: "deploy start gateway",
    update: "deploy update '<gateway>' && deploy start gateway",
  },
};

beforeEach(async () => {
  home = await createTempHomeEnv("supervisor-guidance-");
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
  const pluginDir = path.join(home.home, "deployment");
  await fs.mkdir(pluginDir, { mode: 0o755 });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "deployment",
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(path.join(pluginDir, "index.js"), "throw new Error('must not load runtime');");
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "deployment",
      supervisorGuidance: { version: 1, configKey: "guidance" },
      configSchema: { type: "object", properties: { guidance: { type: "object" } } },
    }),
  );
  config = {
    plugins: {
      load: { paths: [pluginDir] },
      allow: ["deployment"],
      slots: { supervisorGuidance: "deployment" },
      entries: { deployment: { enabled: true, config: { guidance } } },
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await home.restore();
});

describe("external supervisor guidance", () => {
  it("reads a selected manifest without executing the plugin and preserves lifecycle refusal", async () => {
    const resolved = await resolveExternalSupervisorGuidance("start", { config });
    expect(resolved).toEqual({
      version: 1,
      action: "start",
      name: guidance.name,
      runFrom: guidance.runFrom,
      command: guidance.actions.start,
    });
    expect(() => assertGatewayServiceMutationAllowed("start", process.env, resolved)).toThrow(
      "Start (Deployment host): deploy start gateway",
    );
    expect(await resolveExternalSupervisorGuidance("repair", { config })).toBeUndefined();
    expect(formatExternalSupervisorActionRequired("repair")).toContain(
      "Use that supervisor to repair.",
    );
    expect(await resolveExternalSupervisorGuidance("update", { config })).toMatchObject({
      command: guidance.actions.update,
    });
  });

  it.each(["disabled", "denied", "not-allowed", "missing", "unselected", "non-external"])(
    "keeps generic guidance when %s",
    async (mode) => {
      const plugins = config.plugins!;
      if (mode === "disabled") plugins.entries!.deployment.enabled = false;
      if (mode === "denied") plugins.deny = ["deployment"];
      if (mode === "not-allowed") plugins.allow = ["another-plugin"];
      if (mode === "missing") plugins.load = { paths: [] };
      if (mode === "unselected") plugins.slots = {};
      if (mode === "non-external") vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
      expect(await resolveExternalSupervisorGuidance("start", { config })).toBeUndefined();
    },
  );

  it("uses fresh configured values and never renders a malformed command", async () => {
    expect(await resolveExternalSupervisorGuidance("start", { config })).toBeDefined();
    config.plugins!.entries!.deployment.config = {
      guidance: { ...guidance, actions: { start: "new deployment command" } },
    };
    expect(await resolveExternalSupervisorGuidance("start", { config })).toMatchObject({
      command: "new deployment command",
    });
    config.plugins!.entries!.deployment.config = {
      guidance: { ...guidance, actions: { start: "unsafe\ncommand" } },
    };
    expect(await resolveExternalSupervisorGuidance("start", { config })).toBeUndefined();
  });
});
