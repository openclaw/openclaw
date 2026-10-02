/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { projectsForGateway } from "../../lib/projects.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("replaces a retired profile read when the same ID gains profile qualification", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
    { id: modelAccountProfile.id },
  );
  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  const retired = createDeferred<null>();
  const load = vi.fn(harness.context.gateway.loadSelfProfile);
  load.mockReturnValueOnce(retired.promise).mockResolvedValue(modelAccountProfile);
  harness.context.gateway.loadSelfProfile = load;
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  harness.context.gateway.updateSelfUser?.({
    identity: { type: "profile", id: modelAccountProfile.id },
  });
  retired.resolve(null);
  await retired.promise;
  await page.updateComplete;
  expect(load).toHaveBeenCalledTimes(2);
  expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
    modelAccountProfile.displayName,
  );
});

it.each([
  { scopes: ["operator.read"], summary: "You have permission to view server information." },
  { scopes: ["operator.write"], summary: "You have permission to send messages and make changes." },
  {
    scopes: ["operator.sessions.read", "operator.sessions.write"],
    summary: "You have permission to work in your own sessions.",
  },
  {
    scopes: ["operator.sessions.read"],
    summary: "You have permission to view your own sessions.",
  },
  { scopes: ["operator.admin"], summary: "You have permission to manage this server." },
  {
    scopes: ["operator.approvals"],
    summary: "This connection has a limited set of permissions.",
  },
  {
    scopes: ["operator.read", "operator.sessions.write"],
    summary: "You have permission to work in your own sessions.",
  },
])("explains $scopes with diagnostics collapsed", async ({ scopes, summary }) => {
  const request = vi.fn(async () => ({}));
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(gatewayHelloForMethods([], scopes));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;

  const access = page.querySelector("#settings-profile-access");
  expect(access?.querySelector(".settings-row__title")?.textContent).toBe(summary);
  const details = access?.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
  expect(details?.querySelector(".settings-row__value")?.textContent).toBe(scopes.join(", "));
  expect(access?.textContent).toContain(
    "Sessions, browsers, and tools may have additional restrictions.",
  );
  expect(access?.textContent).toContain("Ask your server administrator to review your access.");
  expect(request).not.toHaveBeenCalled();
});

it("distinguishes unreported permissions from an explicit empty grant", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "Your permissions could not be confirmed.",
  );

  harness.emitHello(gatewayHelloForMethods([], []));
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")?.textContent).toContain(
    "This connection has no permissions.",
  );
  expect(page.querySelector("#settings-profile-access")?.textContent).not.toContain(
    "could not be confirmed",
  );
});

it("retires displayed grants on disconnect and uses the newly negotiated scopes", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  harness.emitHello(gatewayHelloForMethods([], ["operator.admin"]));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  expect(page.querySelector("details .settings-row__value")?.textContent).toBe("operator.admin");

  harness.emitConnected(false);
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")).toBeNull();
  expect(page.textContent).not.toContain("You have permission to manage this server.");
  expect(page.querySelector('[role="status"]')?.textContent).toContain("Connecting…");

  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  harness.emitConnected(true);
  await page.updateComplete;
  expect(page.querySelector("details .settings-row__value")?.textContent).toBe("operator.read");

  // Narrow-grant updates do not change the profile editor's broad write permission.
  harness.emitHello(gatewayHelloForMethods([], ["operator.sessions.read"]));
  await page.updateComplete;
  expect(page.querySelector("details .settings-row__value")?.textContent).toBe(
    "operator.sessions.read",
  );
});

it("reconnects through the existing connection owner without requesting broader access", async () => {
  const harness = createConnectedContext(
    vi.fn(async () => ({})) as GatewayBrowserClient["request"],
  );
  harness.emitHello(gatewayHelloForMethods([], ["operator.read"]));
  vi.mocked(harness.context.gateway.connect).mockImplementation(() => harness.emitConnected(false));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;

  const reconnect = page.querySelector<HTMLButtonElement>("#settings-profile-access button");
  const personalEditor = page.querySelector("openclaw-personal-instructions");
  expect(personalEditor).not.toBeNull();
  expect(reconnect?.textContent?.trim()).toBe("Reconnect");
  reconnect?.click();
  expect(harness.context.gateway.connect).toHaveBeenCalledExactlyOnceWith();
  await page.updateComplete;
  expect(page.querySelector("#settings-profile-access")).toBeNull();
  expect(page.querySelector('[role="status"]')?.textContent).toContain("Connecting…");
  expect(page.querySelector("openclaw-personal-instructions")).toBe(personalEditor);
});

it("explains action grants independently of the assigned role name", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile: { ...modelAccountProfile, role: "contributor" } };
    }
    return {};
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    identity: { type: "profile", id: modelAccountProfile.id },
  });
  const scopes = ["operator.sessions.read", "operator.sessions.write"];
  harness.emitHello(gatewayHelloForMethods([], scopes));
  const page = mountProfilePage(harness.context);
  await page.updateComplete;
  await vi.waitFor(() => expect(page.textContent).toContain("contributor"));
  const action = (name: string) =>
    page.querySelector(`[data-access-action="${name}"] .settings-row__value`)?.textContent;
  expect(action("sessionActions")).toBe("Granted");
  expect(action("review")).toBe("Granted");
  for (const name of ["archive", "publication", "serverSettings"]) {
    expect(action(name)).toBe("Not granted");
  }
  expect(page.textContent).toContain("ask a maintainer to review and publish from the same thread");
  expect(page.textContent).not.toContain("Usage statistics");

  harness.emitHello(gatewayHelloForMethods([], [...scopes, "operator.sessions.archive"]));
  await page.updateComplete;
  expect(action("archive")).toBe("Granted");
  expect(action("publication")).toBe("Not granted");
  expect(request.mock.calls.every(([method]) => method === "users.self")).toBe(true);
});

it("shows authoritative project policy and preserves its requirement through a failed refresh", async () => {
  const request = vi.fn(async () => ({
    projects: [{ id: "project-one", displayName: "Project One", source: "registered" }],
    creationPolicy: { workspaceRequired: true, worktreeRequired: true, worktreeBaseRef: "main" },
  }));
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(
    gatewayHelloForMethods(
      ["projects.list"],
      ["operator.sessions.read", "operator.sessions.write"],
    ),
  );
  const page = mountProfilePage(harness.context);
  await vi.waitFor(() => expect(page.textContent).toContain("Project One"));
  expect(page.textContent).toContain("separate worktree and branch from main");
  expect(request).toHaveBeenCalledExactlyOnceWith("projects.list", {});

  request.mockRejectedValueOnce(new Error("unavailable"));
  await projectsForGateway(harness.context.gateway).refresh(true);
  await page.updateComplete;
  expect(page.textContent).toContain("Workspace access could not be loaded");
  expect(page.textContent).toContain("separate worktree and branch from main");
  expect(page.textContent).not.toContain("None available");
  const retry = [
    ...page.querySelectorAll<HTMLButtonElement>("#settings-profile-access button"),
  ].find((button) => button.textContent?.trim() === "Retry");
  expect(retry).toBeDefined();
  retry?.click();
  await vi.waitFor(() => expect(page.textContent).toContain("Project One"));
  expect(page.textContent).not.toContain("Workspace access could not be loaded");
});
