import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
  const pluginDir = await createPlugin("deployment");
  config = {
    plugins: {
      load: { paths: [pluginDir] },
      allow: ["deployment"],
      entries: { deployment: { enabled: true } },
    },
  };
});

async function createPlugin(id: string, copy: unknown = guidance) {
  const pluginDir = path.join(home.home, id);
  await fs.mkdir(pluginDir, { mode: 0o755 });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: id,
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(path.join(pluginDir, "index.js"), "throw new Error('must not load runtime');");
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      supervisorGuidance: copy,
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  return pluginDir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await home.restore();
});

describe("external supervisor guidance", () => {
  it("reads package copy without plugin configuration or runtime execution and preserves lifecycle refusal", async () => {
    delete config.plugins!.entries;
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

  it.each(["disabled", "denied", "not-allowed", "missing", "globally-disabled", "non-external"])(
    "keeps generic guidance when %s",
    async (mode) => {
      const plugins = config.plugins!;
      if (mode === "disabled") {
        expectDefined(plugins.entries?.deployment, "deployment fixture").enabled = false;
      }
      if (mode === "denied") {
        plugins.deny = ["deployment"];
      }
      if (mode === "not-allowed") {
        plugins.allow = ["another-plugin"];
      }
      if (mode === "missing") {
        plugins.load = { paths: [] };
      }
      if (mode === "globally-disabled") {
        plugins.enabled = false;
      }
      if (mode === "non-external") {
        vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
      }
      expect(await resolveExternalSupervisorGuidance("start", { config })).toBeUndefined();
    },
  );

  it("requires one enabled provider even when their actions do not overlap", async () => {
    const secondDir = await createPlugin("another-supervisor", {
      ...guidance,
      actions: { repair: "other repair" },
    });
    const plugins = expectDefined(config.plugins, "plugins fixture");
    plugins.load?.paths?.push(secondDir);
    plugins.allow?.push("another-supervisor");
    const entries = expectDefined(plugins.entries, "entries fixture");
    entries["another-supervisor"] = {
      enabled: true,
    };
    expect(await resolveExternalSupervisorGuidance("start", { config })).toBeUndefined();
    expect(await resolveExternalSupervisorGuidance("repair", { config })).toBeUndefined();
    entries["another-supervisor"].enabled = false;
    expect(await resolveExternalSupervisorGuidance("start", { config })).toMatchObject({
      command: guidance.actions.start,
    });
  });

  it("ignores operator copy and falls back for malformed package guidance", async () => {
    expectDefined(config.plugins?.entries?.deployment, "deployment fixture").config = {
      guidance: { ...guidance, actions: { start: "operator override" } },
    };
    expect(await resolveExternalSupervisorGuidance("start", { config })).toMatchObject({
      command: guidance.actions.start,
    });
    const malformedDir = await createPlugin("malformed", {
      ...guidance,
      actions: { start: "unsafe\ncommand" },
    });
    config = { plugins: { load: { paths: [malformedDir] }, allow: ["malformed"] } };
    expect(await resolveExternalSupervisorGuidance("start", { config })).toBeUndefined();
  });
});
