import { afterEach, expect, it } from "vitest";
import { resolvePluginActivationSourceConfig } from "../plugins/activation-source-config.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  getConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import {
  createRuntimeConfigReader as createReader,
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

it("reuses a frozen source capture while preserving edits before freezing and provenance changes", () => {
  const source = Object.freeze({ gateway: { port: 19001 } });
  setSnapshot({ ...source, tools: {} }, source);
  const first = capture(source);
  expect(capture(source)).not.toBe(first);
  source.gateway.port = 19002;
  freezeJsonSnapshot(source);
  const frozen = capture(source);
  expect(frozen.gateway?.port).toBe(19002);
  expect(first.gateway?.port).toBe(19001);
  expect(frozen).not.toBe(source);
  expect(capture(source)).toBe(frozen);
  expect(projectSource(frozen)).toBe(frozen);

  const facts = createConfigResolutionFacts([]);
  setConfigResolutionFacts(source, facts);
  const rebound = capture(source);
  expect(rebound).not.toBe(frozen);
  expect(getConfigResolutionFacts(rebound)).toBe(facts);
  expect(getConfigResolutionFacts(frozen)).toBeNull();
  setConfigResolutionFacts(rebound, null);
  const repaired = capture(source);
  expect(repaired).not.toBe(rebound);
  expect(getConfigResolutionFacts(repaired)).toBe(facts);
  expect(capture(source)).toBe(repaired);
});

function expectIsolatedCopy(copy: OpenClawConfig, original: OpenClawConfig) {
  expect(copy).toEqual(original);
  expect(copy).not.toBe(original);
}

it("captures authored values and provenance with one isolated runtime generation", () => {
  const source: OpenClawConfig = {
    agents: { entries: { ops: {} } },
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
  setSnapshot(runtime, source);
  runtime.gateway!.auth!.token = "after-publication";
  source.gateway!.auth!.token = "after-publication";
  const next = capture(runtime);
  expect(next).not.toBe(captured);
  expect(next.gateway?.auth?.token).toBe("changed-runtime");
  expect(projectSource(next).gateway?.auth?.token).toBe("changed-source");
  expect(capture(runtime)).toBe(next);
  expect(capture(next)).toBe(next);
  expect(captured.gateway?.auth?.token).toBe("synthetic-resolved-token");
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

it("keeps a source-free capture pinned when its mutable origin later matches the process source", () => {
  const original = { gateway: { port: 19001 } };
  const captured = capture(original);
  expect(projectSource(captured)).toBe(captured);
  expect(capture(captured)).toBe(captured);
  original.gateway.port = 19002;
  expect(captured.gateway?.port).toBe(19001);
  const source: OpenClawConfig = { gateway: { port: 19002 } };
  const runtime: OpenClawConfig = { gateway: { port: 19002, mode: "local" } };
  setSnapshot(runtime, source);
  const scoped = { gateway: { port: 19003 } };
  const pinned = capture(scoped);
  scoped.gateway.port = 19002;
  const read = createReader(pinned);
  expect(read()).toBe(pinned);
  setSnapshot({ gateway: { port: 19003 } }, source);
  expect(read()).toBe(pinned);
});
