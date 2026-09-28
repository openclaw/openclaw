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

  it("drops bidirectional controls from a spoofed device name before the operator sees it", () => {
    const rlo = String.fromCodePoint(0x202e); // RIGHT-TO-LEFT OVERRIDE
    const rli = String.fromCodePoint(0x2067); // RIGHT-TO-LEFT ISOLATE
    const pdf = String.fromCodePoint(0x202c); // POP DIRECTIONAL FORMATTING
    // A device names itself so the override renders it as "Owner's iPhone".
    const spoofed = `Owner${rli}${rlo}enohPi s${pdf}box`;
    const { pending } = parsePairingList({
      pending: [
        { requestId: "r1", nodeId: "n1", displayName: spoofed, remoteIp: "10.0.0.9", ts: 1 },
      ],
    });

    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 80,
      theme,
    });

    for (const control of [rli, rlo, pdf, String.fromCodePoint(0x200f)]) {
      expect(table).not.toContain(control);
    }
    // The literal characters survive, so the reordering is gone but the name is not.
    expect(table).toContain("OwnerenohPi sbox");
  });

  it("keeps right-to-left letters in a device name", () => {
    const { pending } = parsePairingList({
      pending: [
        { requestId: "r1", nodeId: "n1", displayName: "שלום Phone", remoteIp: "10.0.0.1", ts: 1 },
      ],
    });

    const { table } = renderPendingPairingRequestsTable({
      pending,
      now: 1000,
      tableWidth: 80,
      theme,
    });
    expect(table).toContain("שלום Phone");
  });
});
