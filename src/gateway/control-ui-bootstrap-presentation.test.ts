import { describe, expect, it } from "vitest";
import { resolveControlUiBootstrapPresentation } from "./control-ui-bootstrap-presentation.js";

describe("Control UI model defaults bootstrap", () => {
  it.each([undefined, "configured"] as const)(
    "projects %s without model restrictions",
    (newSessionModelDefaults) => {
      const result = resolveControlUiBootstrapPresentation({
        gateway: { controlUi: { newSessionModelDefaults } },
      });
      expect(result.newSessionModelDefaults).toBe(newSessionModelDefaults ?? "last-used");
      expect(result).not.toHaveProperty("modelSelectionPolicy");
    },
  );

  it.each([
    {
      name: "Cloudflare Access trusted proxy",
      authMethod: "trusted-proxy" as const,
      auth: {
        mode: "trusted-proxy" as const,
        allowTailscale: false,
        trustedProxy: {
          userHeader: "cf-access-authenticated-user-email",
          requiredHeaders: ["cf-access-jwt-assertion"],
          allowLoopback: true,
        },
      },
      expected: { provider: "cloudflare-access", path: "/cdn-cgi/access/logout" },
    },
    {
      name: "non-Cloudflare trusted proxy",
      authMethod: "trusted-proxy" as const,
      auth: {
        mode: "trusted-proxy" as const,
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-authenticated-user",
          requiredHeaders: [],
          allowLoopback: true,
        },
      },
      expected: undefined,
    },
    {
      name: "local password fallback",
      authMethod: "password" as const,
      auth: {
        mode: "trusted-proxy" as const,
        allowTailscale: false,
        password: "local-password",
        trustedProxy: {
          userHeader: "cf-access-authenticated-user-email",
          requiredHeaders: ["cf-access-jwt-assertion"],
          allowLoopback: true,
        },
      },
      expected: undefined,
    },
  ])("advertises ingress logout for $name", ({ authMethod, auth, expected }) => {
    expect(resolveControlUiBootstrapPresentation(undefined, authMethod, auth).logout).toEqual(
      expected,
    );
  });
});
