import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuthTokenSourceConflict } from "../gateway/auth-token-source-conflict.js";
import { buildStatusSecretDiagnostics } from "./status-overview-values.js";

function conflictDiagnostic(): string {
  const conflict = resolveGatewayAuthTokenSourceConflict({
    cfg: {
      gateway: { mode: "local", auth: { mode: "token", token: "config-side-token" } },
    } as OpenClawConfig,
    env: { OPENCLAW_GATEWAY_TOKEN: "shell-side-token" },
  });
  expect(conflict?.diagnostic).toBeDefined();
  return conflict!.diagnostic;
}

describe("buildStatusSecretDiagnostics", () => {
  it("renders the token source conflict in full instead of masking its remediation", () => {
    const [rendered] = buildStatusSecretDiagnostics([], [conflictDiagnostic()]);

    // `gateway.auth.token: Remove …` used to read as one `key: value` pair, so the
    // redactor replaced the remediation's leading word with `***`.
    expect(rendered).not.toContain("***");
    expect(rendered).toContain("Remove OPENCLAW_GATEWAY_TOKEN from the shell");
    // The remediation lives past the old 160-character cut.
    expect(rendered?.length).toBeGreaterThan(160);
    expect(rendered?.endsWith("supply the token.")).toBe(true);
  });

  it("still bounds owner ids and paths", () => {
    const longId = "a".repeat(400);
    const [rendered] = buildStatusSecretDiagnostics(
      [
        {
          ownerKind: "agent",
          ownerId: longId,
          state: "unavailable",
          paths: [`${longId}/credentials.json`],
          refKeys: ["agent.openai.apiKey"],
          reason: "ref unavailable",
        },
      ],
      [],
    );

    expect(rendered).toContain(`${"a".repeat(160)} (`);
    expect(rendered).not.toContain("a".repeat(161));
  });
});
