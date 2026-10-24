import { afterEach, expect, it } from "vitest";
import { resolvePluginActivationSourceConfig } from "../plugins/activation-source-config.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  createRuntimeConfigReader as createReader,
  hashRuntimeConfigValue as hashConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot as setSnapshot,
} from "./runtime-snapshot.js";
import {
  captureRuntimeConfig as capture,
  projectConfigOntoRuntimeSourceSnapshot as projectSource,
} from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => resetConfigRuntimeState());

const tokenPath = "gateway.auth.token";
const tokenRef = new Map([[tokenPath, "GATEWAY_TOKEN"]]);
function expectIsolatedCopy(copy: OpenClawConfig, original: OpenClawConfig) {
  expect(copy).toEqual(original);
  expect(copy).not.toBe(original);
  expect(hashConfig(copy)).toBe(hashConfig(original));
}

it("captures authored values and provenance with one isolated runtime generation", () => {
  const source: OpenClawConfig = {
    agents: { entries: { ops: {}, research: {} } },
    gateway: { auth: { mode: "token", token: "${GATEWAY_TOKEN}" } },
  };
  const runtime: OpenClawConfig = {
    ...source,
    gateway: { auth: { mode: "token", token: "synthetic-resolved-token" } },
  };
  retainLegacyDefaultAgentId(runtime, "ops");
  setConfigResolutionFacts(
    runtime,
    createConfigResolutionFacts([], new Map(), "default", tokenRef),
  );
  setSnapshot(runtime, source);

  const captured = capture(runtime);
  const authored = projectSource(captured);
  expectIsolatedCopy(captured, runtime);
  expectIsolatedCopy(authored, source);
  expect(Object.isFrozen(captured.agents?.entries)).toBe(true);
  expect(Object.isFrozen(authored.gateway?.auth)).toBe(true);
  expect(tryGetLegacyDefaultAgentId(captured)).toBeUndefined();
  expect(getResolvedConfigEnvSecretRef(captured, tokenPath)?.id).toBe("GATEWAY_TOKEN");
  expect(resolvePluginActivationSourceConfig({ config: captured })).toBe(authored);
  expect(capture(authored)).toBe(authored);

  source.gateway!.auth!.token = "changed-source";
  runtime.gateway!.auth!.token = "changed-runtime";
  expect(projectSource(runtime).gateway?.auth?.token).toBe("changed-source");
  setSnapshot({ gateway: { port: 19002 } }, { gateway: { port: 19001 } });
  expect(projectSource(captured)).toBe(authored);
  expect(captured.gateway?.auth?.token).toBe("synthetic-resolved-token");
  expect(authored.gateway?.auth?.token).toBe("${GATEWAY_TOKEN}");
});

it("projects runtime edits once while ordinary derived configs remain independent", () => {
  const source: OpenClawConfig = {
    gateway: { port: 19001 },
    tools: { exec: { safeBins: ["jq"] } },
  };
  const runtime: OpenClawConfig = { ...source, gateway: { port: 19001, mode: "local" } };
  setSnapshot(runtime, source);
  const edited = { ...runtime, gateway: { ...runtime.gateway, port: 19002 } };
  const captured = capture(edited);
  const authored = projectSource(captured);
  expect(authored.gateway).toEqual({ port: 19002 });
  expect(projectSource(captured)).toBe(authored);

  const ordinary = projectSource(edited);
  ordinary.tools?.exec?.safeBins?.push("cut");
  expect(projectSource(edited).tools?.exec?.safeBins).toEqual(["jq"]);
  expect(authored.tools?.exec?.safeBins).toEqual(["jq"]);
});

it("uses one captured value when no authored source is active", () => {
  const original = { gateway: { port: 19001 } };
  const captured = capture(original);
  expect(projectSource(captured)).toBe(captured);
  expect(capture(captured)).toBe(captured);
  original.gateway.port = 19002;
  expect(captured.gateway?.port).toBe(19001);
});

it("keeps a scoped capture pinned when its mutable origin later matches the process source", () => {
  const source: OpenClawConfig = { gateway: { port: 19001 } };
  const runtime: OpenClawConfig = { gateway: { port: 19001, mode: "local" } };
  setSnapshot(runtime, source);
  const scoped: OpenClawConfig = { gateway: { port: 19002 } };
  const captured = capture(scoped);
  scoped.gateway!.port = 19001;
  const read = createReader(captured);
  expect(read()).toBe(captured);
  setSnapshot({ gateway: { port: 19003 } }, source);
  expect(read()).toBe(captured);
});
