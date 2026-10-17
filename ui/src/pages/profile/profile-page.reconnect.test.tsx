/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createConnectedContext,
  modelAccountProfile,
  mountProfilePage,
} from "./profile-page.test-support.tsx";

it("retains the name draft and loaded profile through a same-client blip, but retires them for another identity", async () => {
  let profile = modelAccountProfile;
  const request = vi.fn(async (method: string) => {
    if (method === "users.self") {
      return { profile };
    }
    if (method === "users.listModelAccounts") {
      return { profileId: profile.id, accounts: [], links: [] };
    }
    if (method === "users.prefs.get") {
      return { status: "ok", entries: {} };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
    id: modelAccountProfile.id,
    name: "Ada",
  });
  harness.emitHello(gatewayHelloForMethods([], ["operator.write"]));
  const page = mountProfilePage(harness.context);
  const input = () => page.querySelector<HTMLInputElement>(".identity-name-control input");
  try {
    await waitForSolid(() => {
      expect(input()?.value).toBe("Ada");
      expect(input()?.disabled).toBe(false);
    });
    input()!.value = "Ada draft";
    input()!.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    harness.emitConnected(false);
    flush();
    expect(input()?.value).toBe("Ada draft");
    expect(page.textContent).toContain("ada@example.test");
    expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
      true,
    );
    const reads = request.mock.calls.filter(([method]) => method === "users.self").length;
    harness.emitSnapshot({ phase: "connected", selfUser: undefined });
    flush();
    expect(input()?.value).toBe("Ada draft");
    expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "users.self")).toHaveLength(reads);
    harness.emitSnapshot({ selfUser: { id: modelAccountProfile.id, name: "Ada" } });
    await waitForSolid(() => {
      expect(input()?.value).toBe("Ada draft");
      expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
        false,
      );
    });
    profile = { ...modelAccountProfile, id: "profile-2", displayName: "Grace" };
    harness.emitSnapshot({ selfUser: { id: "profile-2", name: "Grace" } });
    await waitForSolid(() => expect(input()?.value).toBe("Grace"));
  } finally {
    page.unmount();
  }
});

it.each(["operator.read", "operator.sessions.read", "operator.sessions.write"])(
  "retires loaded profile details and a pending refresh when %s access is revoked",
  async (scope) => {
    const pending = createDeferred<{ profile: typeof modelAccountProfile }>();
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "users.self") {
        reads += 1;
        return reads === 2 ? pending.promise : { profile: modelAccountProfile };
      }
      if (method === "users.prefs.get") {
        return { status: "ok", entries: {} };
      }
      if (method === "users.github.status") {
        return {
          personal: {
            state: "disconnected",
            generation: null,
            account: null,
            accessExpiresAtMs: null,
            refreshState: "not_applicable",
            pending: null,
          },
          system: {
            source: "system-detected",
            credentialKind: "native",
            credentialState: "unavailable",
            account: null,
            gitAuthor: { name: null, email: null },
            evidence: "none",
            accessExpiresAtMs: null,
            refreshState: "not_applicable",
            oauthScopes: [],
            repositoryGrants: "unknown",
          },
        };
      }
      throw new Error(`Unexpected request ${method}`);
    });
    const harness = createConnectedContext(request as GatewayBrowserClient["request"], {
      id: modelAccountProfile.id,
      name: "Ada",
    });
    harness.emitHello(gatewayHelloForMethods([], [scope]));
    const loadProfile = vi.spyOn(harness.context.gateway, "loadSelfProfile");
    const page = mountProfilePage(harness.context);
    try {
      await waitForSolid(() => expect(page.textContent).toContain("ada@example.test"));
      expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.value).toBe(
        "Ada",
      );
      expect(page.querySelector<HTMLInputElement>(".identity-name-control input")?.disabled).toBe(
        true,
      );
      expect(page.querySelector<HTMLButtonElement>(".identity-name-control button")?.disabled).toBe(
        true,
      );
      expect(page.querySelector('input[type="file"]')).toBeNull();
      await waitForSolid(() =>
        expect(page.querySelector<HTMLButtonElement>(".profile-refresh")?.disabled).toBe(false),
      );
      page.querySelector<HTMLButtonElement>(".profile-refresh")!.click();
      await waitForSolid(() => expect(reads).toBe(2));
      harness.emitHello(gatewayHelloForMethods([], []));
      flush();
      expect(page.textContent).not.toContain("ada@example.test");
      expect(page.querySelector(".identity-name-control")).toBeNull();
      pending.resolve({ profile: modelAccountProfile });
      await loadProfile.mock.results[1]!.value;
      flush();
      expect(page.textContent).not.toContain("ada@example.test");
      expect(page.querySelector(".identity-name-control")).toBeNull();
      expect(reads).toBe(2);

      harness.emitHello(gatewayHelloForMethods([], [scope]));
      await waitForSolid(() => expect(page.textContent).toContain("ada@example.test"));
      expect(reads).toBe(3);
      expect(request.mock.calls.some(([method]) => method === "users.list")).toBe(false);
      expect(
        request.mock.calls.some(([method]) =>
          ["users.setDisplayName", "users.setAvatar", "users.prefs.set"].includes(method),
        ),
      ).toBe(false);
    } finally {
      page.unmount();
    }
  },
);
