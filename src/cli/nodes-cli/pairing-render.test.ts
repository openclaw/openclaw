import { describe, expect, it } from "vitest";
import { parsePairingList } from "../../shared/node-list-parse.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";

function render(pending: unknown[], tableWidth = 80) {
  return renderPendingPairingRequestsTable({
    pending: parsePairingList({ pending }).pending,
    now: 1000,
    tableWidth,
    theme: { heading: (text) => text, muted: (text) => text },
  }).table;
}

const request = (requestId: string, fields: Record<string, unknown> = {}) => ({
  requestId,
  nodeId: requestId,
  ...fields,
});

describe("cli/nodes-cli/pairing-render", () => {
  it("renders pending rows parsed from malformed scalars without throwing", () => {
    // node.pair.list rows are blind-cast from the pairing file; non-string requestId/nodeId/
    // displayName/remoteIp once crashed the renderer's .trim()/sanitizeTerminalText calls.
    expect(() =>
      render([{ requestId: 7, nodeId: {}, displayName: 42, remoteIp: 99, ts: 1 }]),
    ).not.toThrow();
  });

  it("keeps a valid pending label after normalization", () => {
    const table = render([
      { requestId: "r1", nodeId: "n1", displayName: "Phone", remoteIp: "10.0.0.1", ts: 1 },
    ]);
    expect(table).toContain("Phone");
    expect(table).toContain("10.0.0.1");
  });

  it("shows recorded and legacy approval requirements", () => {
    const table = render(
      [
        request("recorded", { requiredApproveScopes: ["operator.pairing", "operator.write"] }),
        request("legacy", { commands: ["system.run"] }),
        request("default", {
          requiredApproveScopes: ["operator.pairing"],
          commands: ["system.run"],
        }),
        request("empty"),
      ],
      120,
    );
    expect(table).toContain("Approval scopes");
    expect(table).toContain("operator.pairing, operator.write");
    expect(table).toContain("operator.pairing, operator.admin");
    expect(table).toMatch(/empty.*operator.pairing/);
    expect(table).toMatch(/default.*operator.pairing, operator.admin/);
  });

  it("keeps untrusted scope text safe in a narrow terminal", () => {
    const table = render(
      [
        request("r1", {
          requiredApproveScopes: ["operator.admin\u001b[2J\nnext\u0007"],
        }),
        request("r2", { requiredApproveScopes: "invalid", commands: ["system.run"] }),
      ],
      70,
    );
    expect(table).toContain("Approval scopes");
    expect(table).toContain("operator.admin");
    expect(table).not.toContain("\u001b");
    expect(table).not.toContain("\u0007");
    expect(table.split("\n").every((line) => line.length <= 70)).toBe(true);
  });
});
