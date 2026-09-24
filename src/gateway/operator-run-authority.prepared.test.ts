import { afterEach, expect, it, vi } from "vitest";
import { assertOperatorModelAllowed } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as profiles from "../state/user-profiles.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("refreshes prepared operator model policy without reading the profile store", () => {
  const readRole = vi.spyOn(profiles, "getUserProfileRole").mockImplementation(() => {
    throw new Error("Unexpected synchronous profile role read");
  });
  const readIdentity = vi.spyOn(profiles, "resolveUserProfileId").mockImplementation(() => {
    throw new Error("Unexpected synchronous profile identity read");
  });
  let config: OpenClawConfig = {
    agents: { defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } } },
    gateway: {
      roles: {
        definitions: {
          writer: {
            scopes: ["operator.write"],
            agents: "*",
            sessions: { others: "none" },
            modelPolicy: {},
          },
        },
      },
    },
  };
  const context = { getRuntimeConfig: () => config };
  let profileCurrent = true;
  const captured = captureGatewayOperatorRunAuthority({
    client: createOperatorClient({ profileId: "prepared-writer", scopes: ["operator.write"] }),
    context,
    preparedProfile: {
      profileId: "prepared-writer",
      role: "writer",
      isCurrent: () => profileCurrent,
    },
  });
  expect(captured).toBeDefined();
  try {
    const authority = captured!.authority;
    expect(() =>
      assertOperatorModelAllowed(authority, { provider: "fixture", model: "a" }),
    ).not.toThrow();
    config = {
      ...config,
      agents: { defaults: { model: { primary: "fixture/b", fallbacks: ["fixture/a"] } } },
    };
    publishOperatorRoleConfigChange(context);
    expect(authority.modelPolicy?.models).toEqual([
      { provider: "fixture", model: "b" },
      { provider: "fixture", model: "a" },
    ]);
    config = structuredClone(config);
    config.gateway!.roles!.definitions.writer!.modelPolicy = { deny: ["fixture/a"] };
    publishOperatorRoleConfigChange(context);
    expect(authority.signal?.aborted).toBe(false);
    expect(authority.assertCurrent).not.toThrow();
    expect(() =>
      assertOperatorModelAllowed(authority, { provider: "fixture", model: "a" }),
    ).toThrow();
    expect(() =>
      assertOperatorModelAllowed(authority, { provider: "fixture", model: "b" }),
    ).not.toThrow();
    expect(readRole).not.toHaveBeenCalled();
    expect(readIdentity).not.toHaveBeenCalled();
    profileCurrent = false;
    expect(authority.assertCurrent).toThrow("operator source identity changed");
  } finally {
    captured?.release();
  }
});
