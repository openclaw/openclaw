/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { mountConfigPageState } from "./config-page.test-support.ts";

afterEach(() => vi.unstubAllGlobals());

it("reads a utility chain and preserves its remaining fallbacks when Activity changes the primary", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  let current = {
    agents: {
      defaults: {
        utilityModel: {
          primary: "fixture/utility",
          fallbacks: ["fixture/backup", "fixture/last"],
        },
      },
    },
  };
  const saved = {
    agents: {
      defaults: {
        utilityModel: { primary: "fixture/backup", fallbacks: ["fixture/last"] },
      },
    },
  };
  let hash = "initial";
  const submissions: unknown[] = [];
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "config.schema") {
      return { schema: { type: "object", properties: {} }, uiHints: {} };
    }
    if (method === "config.patch") {
      if (!isRecord(params) || typeof params.raw !== "string") {
        throw new Error("Expected config.patch raw JSON");
      }
      submissions.push({ raw: JSON.parse(params.raw), replacePaths: params.replacePaths });
      current = saved;
      hash = "saved";
    }
    return { config: current, raw: JSON.stringify(current), hash, valid: true, issues: [] };
  });
  const { gateway } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  try {
    await runtimeConfig.ensureLoaded();
    await runtimeConfig.ensureSchemaLoaded();
    // SAFETY: completeConfigContext supplies the page capabilities unused by this state proof.
    const context = { gateway, runtimeConfig } as unknown as ApplicationContext;
    const { state } = mountConfigPageState(context);
    expect(state.configProps().sessionObserverUtilityModel).toBe("fixture/utility");
    await state.configProps().setSessionObserverUtilityModel?.({
      kind: "model",
      model: "fixture/backup",
    });
    await waitForSolid(() =>
      expect(state.configProps().sessionObserverUtilityModel).toBe("fixture/backup"),
    );
    expect(submissions).toEqual([
      { raw: saved, replacePaths: ["agents.defaults.utilityModel.fallbacks"] },
    ]);
  } finally {
    cleanupSolid();
    runtimeConfig.dispose();
  }
});
