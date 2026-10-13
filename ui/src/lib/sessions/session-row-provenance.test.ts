// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

describe("session row provenance", () => {
  it("merges selected fields without overwriting uncovered facts", () => {
    const provenance = createSessionRowProvenance();
    const identity = {
      key: "agent:main:projected",
      sessionId: "projected",
      kind: "direct" as const,
    };
    const descriptor: GatewaySessionRow = {
      ...identity,
      snapshotAt: 100,
      label: "Earlier title",
      owner: { actor: { type: "human", id: "owner-1" }, assignedAt: 10 },
      model: "test-model",
    };
    const selected: GatewaySessionRow = {
      ...identity,
      rowMode: "fields",
      rowProjectionId: "label-fields",
      snapshotAt: 200,
      label: "Current title",
    };
    provenance.observeReadRow(descriptor, 1);
    provenance.observeProjection(selected, {
      id: "label-fields",
      fields: [
        "key",
        "kind",
        "sessionId",
        "updatedAt",
        "lifecycleRevision",
        "rowMode",
        "rowProjectionId",
        "snapshotAt",
        "label",
      ],
    });
    provenance.observeReadRow(selected, 2, "main");
    const merged = provenance.mergeRow(descriptor, selected);
    expect(merged).toMatchObject({
      label: "Current title",
      owner: { actor: { type: "human", id: "owner-1" }, assignedAt: 10 },
      model: "test-model",
    });

    const ownerCleared: GatewaySessionRow = {
      ...identity,
      rowMode: "fields",
      rowProjectionId: "owner-fields",
      snapshotAt: 300,
    };
    provenance.observeProjection(ownerCleared, {
      id: "owner-fields",
      fields: [
        "key",
        "kind",
        "sessionId",
        "updatedAt",
        "lifecycleRevision",
        "rowMode",
        "rowProjectionId",
        "snapshotAt",
        "owner",
      ],
    });
    provenance.observeReadRow(ownerCleared, 3, "main");
    const next = provenance.mergeRow(merged, ownerCleared);
    expect(next.owner).toBeUndefined();
    expect(next.label).toBe("Current title");
    expect(next.model).toBe("test-model");
  });

  it("retains the sampling time of an unchanged accepted row", () => {
    const provenance = createSessionRowProvenance();
    const row: GatewaySessionRow = {
      key: "agent:main:sampled",
      sessionId: "sampled",
      kind: "direct",
      label: "Current",
      snapshotAt: 100,
    };
    provenance.observeReadRow(row, 1);
    const newer = { ...row, snapshotAt: 200 };
    provenance.observeReadRow(newer, 2);
    const accepted = provenance.mergeRow(row, newer);
    expect(accepted.snapshotAt).toBe(200);
    const cached = { ...row, label: "Earlier", snapshotAt: 150 };
    provenance.observeReadRow(cached, 3);
    expect(provenance.mergeRow(accepted, cached).label).toBe("Current");
  });

  it.each([
    ["descriptor-first", "compact"],
    ["compact-first", "compact"],
    ["descriptor-first", "dashboard"],
    ["compact-first", "dashboard"],
    ["descriptor-first", "sidebar"],
    ["compact-first", "sidebar"],
  ] as const)(
    "retains detail facts across %s %s reads and lets full reads clear them",
    (order, rowMode) => {
      const provenance = createSessionRowProvenance();
      const identity = {
        key: "agent:main:details",
        sessionId: "details",
        kind: "direct" as const,
      };
      const descriptor: GatewaySessionRow = {
        ...identity,
        updatedAt: 100,
        snapshotAt: 100,
        label: "Before",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
        ...(rowMode !== "compact" ? { model: "test-model", totalTokens: 123 } : {}),
      };
      const compact: GatewaySessionRow = {
        ...identity,
        rowMode,
        updatedAt: 200,
        snapshotAt: 200,
        label: "Current",
      };
      const reads: [GatewaySessionRow, GatewaySessionRow] =
        order === "descriptor-first" ? [descriptor, compact] : [compact, descriptor];
      provenance.observeReadRow(reads[0], 1);
      provenance.observeReadRow(reads[1], 2);
      const merged = provenance.mergeRow(reads[0], reads[1]);
      expect(merged).toMatchObject({
        label: "Current",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
        ...(rowMode !== "compact" ? { model: "test-model", totalTokens: 123 } : {}),
      });

      const cleared: GatewaySessionRow = {
        ...identity,
        updatedAt: 300,
        snapshotAt: 300,
        label: "Current",
      };
      provenance.observeReadRow(cleared, 3);
      const next = provenance.mergeRow(merged, cleared);
      expect(next.thinkingLevels).toBeUndefined();
      expect(next.toolOverrides).toBeUndefined();
      expect(next.model).toBeUndefined();
      expect(next.totalTokens).toBeUndefined();
      expect(next.rowMode).toBeUndefined();
    },
  );
});
