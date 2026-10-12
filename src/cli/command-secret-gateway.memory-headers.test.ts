import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coerceConfig, resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { getPath } from "../secrets/path-utils.js";
import { resolveCommandSecretRefsViaGateway } from "./command-secret-gateway.js";
import { getMemoryEmbeddingCommandSecretTargetIds } from "./command-secret-targets.js";

const { callGateway } = vi.hoisted(() => ({ callGateway: vi.fn() }));

// mock-isolation: Stub external Gateway RPC while config loading and secret preparation stay real.
vi.mock("../gateway/call.js", () => ({ callGateway }));

beforeEach(() => {
  callGateway.mockReset();
  vi.stubEnv("OPENCLAW_TEST_MEMORY_HEADER", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  { name: "default", prefix: [] },
  { name: "per-agent", prefix: ["agents", "entries", "main"] },
])("$name memory header command preparation", ({ prefix }) => {
  const pathSegments = [...prefix, "memory", "search", "remote", "headers", "Authorization"];
  const targetPath = pathSegments.join(".");

  function loadedConfig() {
    const memory = {
      search: {
        provider: "lmstudio",
        remote: { headers: { Authorization: "${OPENCLAW_TEST_MEMORY_HEADER}" } },
      },
    };
    const source = prefix.length === 0 ? { memory } : { agents: { entries: { main: { memory } } } };
    const read = resolveConfigForRead(source, {});
    const config = coerceConfig(read.resolvedConfigRaw);
    setConfigResolutionFacts(config, read.resolutionFacts);
    return config;
  }

  it.each(["incomplete", "unavailable"])(
    "rejects an unresolved authored header with its setting path when Gateway is %s",
    async (gatewayState) => {
      if (gatewayState === "unavailable") {
        callGateway.mockRejectedValue(new Error("Gateway unavailable"));
      } else {
        callGateway.mockResolvedValue({ assignments: [], diagnostics: [] });
      }

      await expect(
        resolveCommandSecretRefsViaGateway({
          config: loadedConfig(),
          commandName: "memory index",
          targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
        }),
      ).rejects.toThrow(`${targetPath} is unresolved`);
    },
  );

  it("preserves a resolved template-looking header without resolving it again", async () => {
    const literal = "${RESOLVED_MEMORY_HEADER_LITERAL}";
    callGateway.mockResolvedValue({
      assignments: [{ path: targetPath, pathSegments, value: literal }],
      diagnostics: [],
    });
    const request = {
      commandName: "memory index",
      targetIds: getMemoryEmbeddingCommandSecretTargetIds(),
    };

    const prepared = await resolveCommandSecretRefsViaGateway({
      ...request,
      config: loadedConfig(),
    });
    expect(getPath(prepared.resolvedConfig, pathSegments)).toBe(literal);

    const repeated = await resolveCommandSecretRefsViaGateway({
      ...request,
      config: prepared.resolvedConfig,
    });
    expect(getPath(repeated.resolvedConfig, pathSegments)).toBe(literal);
    expect(callGateway).toHaveBeenCalledOnce();
  });
});
