// Pending pairing render tests cover crash-safety for malformed pairing-list scalars.
import { describe, expect, it } from "vitest";
import { parsePairingList } from "../../shared/node-list-parse.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";

const theme = {
  heading: (text: string) => text,
  warn: (text: string) => text,
  muted: (text: string) => text,
};

describe("cli/nodes-cli/pairing-render", () => {
  it("renders pending rows parsed from malformed scalars without throwing", () => {
    // node.pair.list rows are blind-cast from the pairing file; non-string requestId/nodeId/
    // displayName/remoteIp once crashed the renderer's .trim()/sanitizeTerminalText calls.
    const { pending } = parsePairingList({
      pending: [{ requestId: 7, nodeId: {}, displayName: 42, remoteIp: 99, ts: 1 }],
    });

    expect(() =>
      renderPendingPairingRequestsTable({ pending, now: 1000, tableWidth: 80, theme }),
    ).not.toThrow();
  });

  it("keeps a valid pending label after normalization", () => {
    const { pending } = parsePairingList({
      pending: [
        { requestId: "r1", nodeId: "n1", displayName: "Phone", remoteIp: "10.0.0.1", ts: 1 },
      ],
    });

    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 80,
      theme,
    });
    expect(table).toContain("Phone");
    expect(table).toContain("10.0.0.1");
  });

  it("shows recorded and legacy approval requirements", () => {
    const { pending } = parsePairingList({
      pending: [
        {
          requestId: "recorded",
          nodeId: "n1",
          requiredApproveScopes: ["operator.pairing", "operator.write"],
        },
        { requestId: "legacy", nodeId: "n2", commands: ["system.run"] },
        {
          requestId: "default",
          nodeId: "n3",
          requiredApproveScopes: ["operator.pairing"],
          commands: ["system.run"],
        },
        { requestId: "empty", nodeId: "n4" },
      ],
    });
    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 120,
      theme,
    });
    expect(table).toContain("Approval scopes");
    expect(table).toContain("operator.pairing, operator.write");
    expect(table).toContain("operator.pairing, operator.admin");
    expect(table).toMatch(/empty.*operator.pairing/);
    expect(table).toMatch(/default.*operator.pairing, operator.admin/);
  });

  it("keeps untrusted scope text safe in a narrow terminal", () => {
    const { pending } = parsePairingList({
      pending: [
        {
          requestId: "r1",
          nodeId: "n1",
          requiredApproveScopes: ["operator.admin\u001b[2J\nnext\u0007"],
        },
        {
          requestId: "r2",
          nodeId: "n2",
          requiredApproveScopes: "invalid",
          commands: ["system.run"],
        },
      ],
    });
    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 70,
      theme,
    });
    expect(table).toContain("Approval scopes");
    expect(table).toContain("operator.admin");
    expect(table).not.toContain("\u001b");
    expect(table).not.toContain("\u0007");
    expect(table.split("\n").every((line) => line.length <= 70)).toBe(true);
  });
});
