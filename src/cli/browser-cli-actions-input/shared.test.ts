import { describe, expect, it } from "vitest";
import type { SnapshotResult } from "../../browser/client.js";
import { readFields, resolveFieldsFromSnapshot } from "./shared.js";

describe("browser fill field parsing", () => {
  it("accepts ref-based field descriptors", async () => {
    const fields = await readFields({
      fields: '[{"ref":"e1","type":"textbox","value":"Ada"}]',
    });
    expect(fields).toEqual([{ ref: "e1", type: "textbox", value: "Ada" }]);
  });

  it("accepts label-based field descriptors", async () => {
    const fields = await readFields({
      fields: '[{"label":"Email","type":"textbox","value":"ada@example.com"}]',
    });
    expect(fields).toEqual([{ label: "Email", type: "textbox", value: "ada@example.com" }]);
  });

  it("rejects entries missing ref and label", async () => {
    await expect(
      readFields({
        fields: '[{"type":"textbox","value":"Ada"}]',
      }),
    ).rejects.toThrow("fields[0] must include ref or label");
  });
});

describe("browser fill label resolution", () => {
  const snapshot: SnapshotResult = {
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "",
    refs: {
      e1: { role: "textbox", name: "Email" },
      e2: { role: "button", name: "Submit" },
    },
  };

  it("resolves labels to refs", () => {
    const resolved = resolveFieldsFromSnapshot(
      [{ label: "Email", type: "textbox", value: "ada@example.com" }],
      snapshot,
    );
    expect(resolved).toEqual([{ ref: "e1", type: "textbox", value: "ada@example.com" }]);
  });

  it("throws when no matching ref exists", () => {
    expect(() =>
      resolveFieldsFromSnapshot([{ label: "Missing", type: "textbox", value: "Ada" }], snapshot),
    ).toThrow('fields[0] no snapshot match for label "Missing" and type "textbox"');
  });

  it("throws when multiple matching refs exist", () => {
    const dupSnapshot: SnapshotResult = {
      ...snapshot,
      refs: {
        e1: { role: "textbox", name: "Email" },
        e9: { role: "textbox", name: "Email" },
      },
    };

    expect(() =>
      resolveFieldsFromSnapshot([{ label: "Email", type: "textbox", value: "Ada" }], dupSnapshot),
    ).toThrow('fields[0] has multiple matches for label "Email" and type "textbox"');
  });
});
