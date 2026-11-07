/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  browserCredentialAfterApply,
  createGatewayAuthDraft,
  gatewayAuthIssue,
  gatewayAuthPatch,
  stageGatewayAuthEdit,
  type GatewayAuthDraft,
} from "./gateway-auth-draft.ts";

const saved = { mode: "token", token: REDACTED_SENTINEL };

function staged(
  edits: Array<[Array<string | number>, unknown]>,
  base: Record<string, unknown> = saved,
): GatewayAuthDraft {
  return edits.reduce<GatewayAuthDraft>(
    (draft, [path, value]) => stageGatewayAuthEdit(draft, ["gateway", "auth", ...path], { value }),
    { base, next: structuredClone(base) },
  );
}

describe("gateway auth draft", () => {
  it("requires the trusted-proxy header and proxy list, then drops the shared token", () => {
    const draft = staged([[["mode"], "trusted-proxy"]]);
    expect(gatewayAuthIssue(draft, { gateway: { trustedProxies: ["10.0.0.1"] } })).toBe(
      "userHeaderRequired",
    );

    const withHeader = stageGatewayAuthEdit(
      draft,
      ["gateway", "auth", "trustedProxy", "userHeader"],
      {
        value: "x-forwarded-user",
      },
    );
    expect(gatewayAuthIssue(withHeader, { gateway: { trustedProxies: [] } })).toBe(
      "trustedProxiesRequired",
    );
    expect(gatewayAuthIssue(withHeader, { gateway: { trustedProxies: ["10.0.0.1"] } })).toBeNull();
    expect(gatewayAuthPatch(withHeader).patch).toEqual({
      mode: "trusted-proxy",
      token: null,
      trustedProxy: { userHeader: "x-forwarded-user" },
    });
    expect(browserCredentialAfterApply(withHeader)).toBeNull();
  });

  it("keeps a saved secret when its input is cleared", () => {
    const draft = staged([
      [["token"], "next-token"],
      [["token"], ""],
    ]);
    expect(draft.next.token).toBe(REDACTED_SENTINEL);
    expect(gatewayAuthPatch(draft).patch).toEqual({});
  });

  it("does not ask for a credential the current mode may already get elsewhere", () => {
    const envBacked = { mode: "password" };
    expect(gatewayAuthIssue(staged([[["allowTailscale"], true]], envBacked), {})).toBeNull();
    expect(gatewayAuthIssue(staged([[["mode"], "token"]], envBacked), {})).toBe("tokenRequired");
  });

  it("replaces edited arrays instead of merging them", () => {
    const base = {
      mode: "trusted-proxy",
      trustedProxy: { userHeader: "x-user", allowUsers: ["a", "b"] },
    };
    const draft = staged([[["trustedProxy", "allowUsers"], ["a"]]], base);
    expect(gatewayAuthPatch(draft)).toEqual({
      patch: { trustedProxy: { allowUsers: ["a"] } },
      replacePaths: ["gateway.auth.trustedProxy.allowUsers"],
    });
  });

  it("reconnects with a replaced token but not with the saved one", () => {
    expect(browserCredentialAfterApply(staged([[["token"], "fresh-token"]]))).toEqual({
      token: "fresh-token",
    });
    expect(
      browserCredentialAfterApply(
        staged([[["mode"], "token"]], { mode: "password", token: REDACTED_SENTINEL }),
      ),
    ).toBeNull();
  });

  it("drops the draft when edits return to the saved values", () => {
    const controller = createGatewayAuthDraft({
      readCurrent: () => structuredClone(saved),
      apply: vi.fn(async () => true),
      failureMessage: () => "failed",
      reconnect: vi.fn(),
    });
    controller.stage(["gateway", "auth", "mode"], { value: "password" });
    flush();
    expect(controller.draft()?.next.mode).toBe("password");
    controller.stage(["gateway", "auth", "mode"], { value: "token" });
    flush();
    expect(controller.draft()).toBeNull();
  });
});
