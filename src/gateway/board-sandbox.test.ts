import { describe, expect, it } from "vitest";
import {
  buildSandboxHostContentSecurityPolicy,
  decodeSandboxHostCsp,
} from "../agents/sandbox-host.js";
import type { BoardWidgetDocument } from "../boards/board-store.js";
import {
  buildBoardWidgetContentSecurityPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(
  grantState: "pending" | "granted",
  netOrigins = ["https://api.open-meteo.com"],
): BoardWidgetDocument {
  return {
    html: "<!doctype html>",
    revision: 1,
    sha256: "a".repeat(64),
    viewGeneration: "b".repeat(32),
    grantState,
    declared: { netOrigins },
  };
}

describe("board widget sandbox CSP", () => {
  it("emits no network authority while a declaration is pending", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));

    expect(path).toBe("/mcp-app-sandbox");
    expect(buildSandboxHostContentSecurityPolicy()).toContain("connect-src 'none'");
    expect(buildBoardWidgetContentSecurityPolicy(document("pending"))).toContain(
      "connect-src 'none'",
    );
  });

  it("emits only the granted widget origins", () => {
    const path = buildBoardWidgetSandboxPath(
      document("granted", [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ]),
    );
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp).toEqual({
      connectDomains: [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ],
    });
    expect(buildSandboxHostContentSecurityPolicy(csp)).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
    expect(
      buildBoardWidgetContentSecurityPolicy(document("granted", csp?.connectDomains)),
    ).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
  });
});
