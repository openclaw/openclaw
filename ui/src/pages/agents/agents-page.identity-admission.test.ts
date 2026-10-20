/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  agentsCapability,
  createAgentsPage,
  emitGatewaySnapshot,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";

function admissionFixture() {
  const configWrite = createDeferred<object>();
  let config: Record<string, unknown> = { pending: false };
  let hash = "hash-1";
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set") {
      const result = await configWrite.promise;
      config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
      hash = "hash-2";
      return result;
    }
    if (method === "agents.update") {
      return {};
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const currentGateway = gateway(snapshot(client));
  currentGateway.snapshot.selfUser = { id: "first-operator" };
  const runtimeConfig = createRuntimeConfigCapability(currentGateway);
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "main", files: [] }));
  const context = { ...pageContext(currentGateway, agents), runtimeConfig };
  return { configWrite, request, client, currentGateway, runtimeConfig, context };
}

async function queueIdentityBehindConfig(fixture: ReturnType<typeof admissionFixture>) {
  await fixture.runtimeConfig.ensureLoaded();
  const page = createAgentsPage(fixture.context);
  fixture.runtimeConfig.patchForm(["pending"], true);
  page.read().overview.onIdentityFieldChange("name", "Retained main-agent draft");
  page.read().overview.onIdentitySave();
  await waitForFast(() =>
    expect(fixture.request).toHaveBeenCalledWith("config.set", expect.anything()),
  );
  expect(fixture.request).not.toHaveBeenCalledWith("agents.update", expect.anything());
  return page;
}

it("restores and saves a main-agent draft after route teardown on the original Gateway", async () => {
  const fixture = admissionFixture();
  try {
    const firstPage = await queueIdentityBehindConfig(fixture);
    firstPage.dispose();
    const restoredPage = createAgentsPage(fixture.context);
    expect(restoredPage.read().overview.identityDraft.name).toBe("Retained main-agent draft");

    fixture.configWrite.resolve({});
    await waitForFast(() =>
      expect(fixture.request).toHaveBeenCalledWith("agents.update", {
        agentId: "main",
        name: "Retained main-agent draft",
      }),
    );
  } finally {
    fixture.runtimeConfig.dispose();
  }
});

it.each(["profile", "Gateway", "permission"] as const)(
  "does not dispatch a retained identity draft after %s authority changes during real admission",
  async (change) => {
    const fixture = admissionFixture();
    try {
      const page = await queueIdentityBehindConfig(fixture);
      const admissionDrained = fixture.runtimeConfig.runExternalMutation(async () => true);
      if (change === "profile") {
        page.dispose();
        fixture.currentGateway.snapshot.selfUser = { id: "second-operator" };
        const secondPage = createAgentsPage(fixture.context);
        expect(secondPage.read().overview.identityDraft.name).toBeNull();
      } else if (change === "Gateway") {
        page.dispose();
        const nextClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
        emitGatewaySnapshot(fixture.currentGateway, snapshot(nextClient));
        const secondPage = createAgentsPage(fixture.context);
        expect(secondPage.read().overview.identityDraft.name).toBeNull();
      } else {
        fixture.currentGateway.snapshot.hello = gatewayHelloForMethods(
          ["agents.update", "config.set"],
          ["operator.read"],
        );
      }
      fixture.configWrite.resolve({});
      await admissionDrained;
      expect(fixture.request).not.toHaveBeenCalledWith("agents.update", expect.anything());
    } finally {
      fixture.runtimeConfig.dispose();
    }
  },
);
