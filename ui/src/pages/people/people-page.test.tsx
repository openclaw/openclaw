/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { UserProfile } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createConnectedContext } from "../profile/profile-page.test-support.tsx";
import { PeoplePage } from "./people-page.tsx";

const alice: UserProfile = {
  id: "alice",
  displayName: "Alice",
  role: "guest",
  effectiveRole: "guest",
  roleSource: "assigned",
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: [],
};
const bob: UserProfile = {
  ...alice,
  id: "bob",
  displayName: "Bob",
  role: undefined,
  effectiveRole: "maintainer",
  roleSource: "githubLogin",
};
const runtime = {
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: {
          agents: ["main"],
          sessions: { others: "view" },
          sandbox: "required",
          scopes: ["operator.sessions.read"],
        },
        maintainer: { agents: "*", sessions: { others: "write" }, scopes: ["operator.read"] },
      },
    },
  },
};

async function fixture(scopes = ["operator.read"], personId = "alice", failDirectory = false) {
  const request = vi.fn(async (method: string) => {
    if (method === "users.list") {
      if (failDirectory) {
        throw new Error("Directory failed");
      }
      return { profiles: [alice, bob] };
    }
    if (method === "config.get") {
      return { exists: true, valid: true, config: {}, runtimeConfig: runtime };
    }
    throw new Error("Unexpected RPC: " + method);
  });
  const client = createTestGatewayClient(request);
  const source = createConnectedContext((...args) => client.request(...args), {
    id: "self",
    name: "Self",
    identity: { type: "profile", id: "self" },
  });
  source.emitHello(gatewayHelloForMethods(["users.list", "config.get"], scopes));
  const runtimeConfig = createRuntimeConfigCapability(source.context.gateway);
  onTestFinished(() => runtimeConfig.dispose());
  const context = { ...source.context, runtimeConfig };
  if (scopes.includes("operator.read")) {
    await runtimeConfig.ensureDisplayLoaded();
  }
  const [route, setRoute] = createSignal(personId ? "?person=" + encodeURIComponent(personId) : "");
  const provider = createSolidApplicationContextProvider(context);
  const page = mountSolid(() => <PeoplePage routeData={route()} />, { wrapper: provider.wrapper });
  await waitForSolid(() => expect(page.container.textContent).not.toContain("Loading…"));
  return { ...source, request, page, setRoute };
}

it("uses Gateway-resolved role mappings, preserves selected detail while filtering, and never writes", async () => {
  const { page, request, setRoute } = await fixture();
  await waitForSolid(() => expect(page.container.textContent).toContain("Required"));
  const search = page.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = "Bob";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(page.container.querySelectorAll('button[aria-current="true"]')).toHaveLength(0);
  expect(page.container.textContent).toContain("Alice");
  expect(request.mock.calls.filter(([method]) => method === "users.list")).toHaveLength(1);
  setRoute("?view=roles&role=maintainer");
  flush();
  expect(page.container.textContent).toContain("All configured agents");
  expect(page.container.textContent).toContain("GitHub login mapping");
  expect(page.container.textContent).toContain("Bob");
  expect(request.mock.calls.some(([method]) => method === "users.setRole")).toBe(false);
});

it("never reads directory or configured policy for a guest, including another-person deep links", async () => {
  const { page, request, setRoute } = await fixture([
    "operator.sessions.read",
    "operator.sessions.write",
  ]);
  expect(page.container.textContent).toContain(
    "This profile is unavailable or cannot be read with your current access.",
  );
  expect(page.container.textContent).not.toContain("Alice");
  expect(request).not.toHaveBeenCalled();
  setRoute("");
  flush();
  expect(page.container.textContent).toContain("operator.sessions.read, operator.sessions.write");
  expect(request).not.toHaveBeenCalled();
});

it("retires policy and profile presentation immediately when directory access is lost", async () => {
  const test = await fixture();
  const { page } = test;
  await waitForSolid(() => expect(page.container.textContent).toContain("Required"));
  test.emitHello(gatewayHelloForMethods(["users.list", "config.get"], ["operator.sessions.read"]));
  flush();
  expect(page.container.textContent).not.toContain("Alice");
  expect(page.container.textContent).not.toContain("Required");
  expect(page.container.textContent).toContain("This profile is unavailable");
});

it("shows a failed directory as unavailable rather than an empty membership list", async () => {
  const { page, setRoute } = await fixture(["operator.read"], "alice", true);
  await waitForSolid(() => expect(page.container.textContent).toContain("Couldn’t load people"));
  setRoute("?view=roles&role=guest");
  flush();
  expect(page.container.textContent).toContain("People using this role");
  expect(page.container.textContent).not.toContain("No people use this role.");
});

it("loads configured policy when broad read access becomes available on the open page", async () => {
  const test = await fixture(["operator.sessions.read"]);
  expect(test.request).not.toHaveBeenCalled();
  test.emitHello(gatewayHelloForMethods(["users.list", "config.get"], ["operator.read"]));
  await waitForSolid(() => expect(test.page.container.textContent).toContain("Required"));
  expect(test.request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
});
