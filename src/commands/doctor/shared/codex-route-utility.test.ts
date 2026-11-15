import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { makeProviderModelFixture } from "../../../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectCodexRuntimeRouteHits } from "./codex-route-config-scan.js";

describe("Doctor implicit routes with agent utility settings", () => {
  it.each([false, true])(
    "resolves inherited implicit routes with utility separation %s",
    (separated) => {
      const cfg: OpenClawConfig = {
        ...(separated ? { meta: { migrations: { utilityModelSeparation: true as const } } } : {}),
        agents: {
          ownership: "explicit",
          entries: {
            worker: {
              utilityModel: "helper@local:utility",
              models: { "local-utility/small": { alias: "helper" } },
            },
            disabled: { utilityModel: "" },
          },
        },
        models: {
          providers: {
            "local-utility": {
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                makeProviderModelFixture({
                  id: "small",
                  provider: "local-utility",
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:9/v1",
                }),
              ],
            },
          },
        },
      };
      const original = structuredClone(cfg);
      expect(
        collectCodexRuntimeRouteHits(cfg, {}).filter((hit) => hit.path === "agents.defaults.model"),
      ).toEqual(
        separated
          ? [
              expect.objectContaining({
                agentId: "worker",
                modelRef: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
              }),
            ]
          : [],
      );
      expect(cfg).toEqual(original);
    },
  );
});
