import { afterEach, describe, expect, it } from "vitest";
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
  createRuntimeConfigReader,
  hashRuntimeConfigValue,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

describe("captured runtime config source", () => {
  afterEach(() => resetConfigRuntimeState());

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
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["gateway.auth.token", "GATEWAY_TOKEN"]]),
      ),
    );
    setRuntimeConfigSnapshot(runtime, source);

    const captured = captureRuntimeConfig(runtime);
    const authored = projectConfigOntoRuntimeSourceSnapshot(captured);
    expect(captured).toEqual(runtime);
    expect(captured).not.toBe(runtime);
    expect(authored).toEqual(source);
    expect(authored).not.toBe(source);
    expect(hashRuntimeConfigValue(captured)).toBe(hashRuntimeConfigValue(runtime));
    expect(hashRuntimeConfigValue(authored)).toBe(hashRuntimeConfigValue(source));
    expect(Object.isFrozen(captured.agents?.entries)).toBe(true);
    expect(Object.isFrozen(authored.gateway?.auth)).toBe(true);
    expect(tryGetLegacyDefaultAgentId(captured)).toBe("ops");
    expect(getResolvedConfigEnvSecretRef(captured, "gateway.auth.token")?.id).toBe("GATEWAY_TOKEN");
    expect(resolvePluginActivationSourceConfig({ config: captured })).toBe(authored);
    expect(captureRuntimeConfig(authored)).toBe(authored);

    source.gateway!.auth!.token = "changed-source";
    runtime.gateway!.auth!.token = "changed-runtime";
    expect(projectConfigOntoRuntimeSourceSnapshot(runtime).gateway?.auth?.token).toBe(
      "changed-source",
    );
    setRuntimeConfigSnapshot({ gateway: { port: 19002 } }, { gateway: { port: 19001 } });
    expect(projectConfigOntoRuntimeSourceSnapshot(captured)).toBe(authored);
    expect(captured.gateway?.auth?.token).toBe("synthetic-resolved-token");
    expect(authored.gateway?.auth?.token).toBe("${GATEWAY_TOKEN}");
  });

  it("projects runtime edits once while ordinary derived configs remain independent", () => {
    const source: OpenClawConfig = {
      gateway: { port: 19001 },
      tools: { exec: { safeBins: ["jq"] } },
    };
    const runtime: OpenClawConfig = { ...source, gateway: { port: 19001, mode: "local" } };
    setRuntimeConfigSnapshot(runtime, source);
    const edited = { ...runtime, gateway: { ...runtime.gateway, port: 19002 } };
    const captured = captureRuntimeConfig(edited);
    const authored = projectConfigOntoRuntimeSourceSnapshot(captured);
    expect(authored.gateway).toEqual({ port: 19002 });
    expect(projectConfigOntoRuntimeSourceSnapshot(captured)).toBe(authored);

    const ordinary = projectConfigOntoRuntimeSourceSnapshot(edited);
    ordinary.tools?.exec?.safeBins?.push("cut");
    expect(projectConfigOntoRuntimeSourceSnapshot(edited).tools?.exec?.safeBins).toEqual(["jq"]);
    expect(authored.tools?.exec?.safeBins).toEqual(["jq"]);
  });

  it("uses one captured value when no authored source is active", () => {
    const original = { gateway: { port: 19001 } };
    const captured = captureRuntimeConfig(original);
    expect(projectConfigOntoRuntimeSourceSnapshot(captured)).toBe(captured);
    expect(captureRuntimeConfig(captured)).toBe(captured);
    original.gateway.port = 19002;
    expect(captured.gateway?.port).toBe(19001);
  });

  it("keeps a scoped capture pinned when its mutable origin later matches the process source", () => {
    const source: OpenClawConfig = { gateway: { port: 19001 } };
    const runtime: OpenClawConfig = { gateway: { port: 19001, mode: "local" } };
    setRuntimeConfigSnapshot(runtime, source);
    const scoped: OpenClawConfig = { gateway: { port: 19002 } };
    const captured = captureRuntimeConfig(scoped);
    scoped.gateway!.port = 19001;
    const read = createRuntimeConfigReader(captured);
    expect(read()).toBe(captured);
    setRuntimeConfigSnapshot({ gateway: { port: 19003 } }, source);
    expect(read()).toBe(captured);
  });
});
