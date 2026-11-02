/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  agentsCapability,
  createAgentsPage,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";

function identityContext(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "main", files: [] }));
  const context = pageContext(gateway(snapshot(client)), agents);
  context.agentIdentity.invalidate = vi.fn();
  context.runtimeConfig.runExternalMutation = async (task) => ({
    ok: true as const,
    value: await task(client),
    refresh: { ok: true as const },
  });
  return { client, context };
}

it("debounces identity edits and automatically saves the latest name", async () => {
  const request = vi.fn(async () => ({}));
  const { context } = identityContext(request as GatewayBrowserClient["request"]);
  const page = createAgentsPage(context);
  page.read().overview.onIdentityFieldChange("name", "First name");
  page.read().overview.onIdentityFieldChange("name", "Second name");

  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("agents.update", {
      agentId: "main",
      name: "Second name",
    }),
  );
  expect(request).toHaveBeenCalledOnce();
});

it("saves a newer edit after route teardown while an older save is in flight", async () => {
  const firstUpdate = createDeferred<object>();
  const request = vi.fn(async (method: string, params: { name?: string }) => {
    if (method === "agents.update" && params.name === "First name") {
      return firstUpdate.promise;
    }
    return {};
  });
  const { context } = identityContext(request as GatewayBrowserClient["request"]);
  const firstPage = createAgentsPage(context);
  firstPage.read().overview.onIdentityFieldChange("name", "First name");
  firstPage.read().overview.onIdentitySave();
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());

  firstPage.read().overview.onIdentityFieldChange("name", "Second name");
  firstPage.dispose();
  const secondPage = createAgentsPage(context);
  expect(secondPage.read().readData().identityDraft.name).toBe("Second name");
  expect(request).toHaveBeenCalledTimes(1);

  firstUpdate.resolve({});
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("agents.update", {
      agentId: "main",
      name: "Second name",
    }),
  );
});

it("does not replay a retained draft into a different Gateway", () => {
  const firstRequest = vi.fn(async () => ({}));
  const { context } = identityContext(firstRequest as GatewayBrowserClient["request"]);
  const firstPage = createAgentsPage(context);
  firstPage.read().overview.onIdentityFieldChange("name", "Private first-Gateway draft");
  firstPage.dispose();

  const secondRequest = vi.fn(async () => ({}));
  const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
  Object.assign(context, { gateway: gateway(snapshot(secondClient)) });
  const secondPage = createAgentsPage(context);
  expect(secondPage.read().readData().identityDraft.name).toBeNull();
  expect(secondRequest).not.toHaveBeenCalledWith("agents.update", expect.anything());
});

it("does not restore an unmounted draft after the operator profile changes", () => {
  const request = vi.fn(async () => ({}));
  const { context } = identityContext(request as GatewayBrowserClient["request"]);
  context.gateway.snapshot.selfUser = { id: "first-operator" };
  const firstPage = createAgentsPage(context);
  firstPage.read().overview.onIdentityFieldChange("name", "Private first-profile draft");
  firstPage.dispose();

  context.gateway.snapshot.selfUser = { id: "second-operator" };
  const secondPage = createAgentsPage(context);
  expect(secondPage.read().readData().identityDraft.name).toBeNull();
  expect(request).not.toHaveBeenCalledWith("agents.update", expect.anything());
});
