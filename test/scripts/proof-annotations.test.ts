import { describe, expect, it } from "vitest";
import {
  renderProofAnnotations,
  validateProofAnnotations,
  type ProofAnnotation,
} from "../../scripts/lib/proof-annotations.ts";

const viewport = { width: 800, height: 600 };
const first = { x: 120, y: 100, width: 200, height: 40 };

describe("proof annotations", () => {
  it("reports the measured horizontal alignment error, including a zero-offset result", () => {
    const before: ProofAnnotation[] = [
      { kind: "alignment", axis: "x", edge: "start", rects: [first, { ...first, x: 144, y: 220 }] },
    ];
    const after: ProofAnnotation[] = [
      { kind: "alignment", axis: "x", edge: "start", rects: [first, { ...first, y: 220 }] },
    ];
    expect(renderProofAnnotations(before, viewport)).toContain("Max Δx 24 px");
    expect(renderProofAnnotations(after, viewport)).toContain("Max Δx 0 px");
  });

  it("measures center alignment across unequal sizes and fractional coordinates", () => {
    expect(
      renderProofAnnotations(
        [
          {
            kind: "alignment",
            axis: "y",
            edge: "center",
            rects: [first, { x: 400, y: 110.5, width: 100, height: 20 }],
          },
        ],
        viewport,
      ),
    ).toContain("Max Δy 0.5 px");
  });

  it.each([
    [160, "Gap 20 px"],
    [130, "Overlap 10 px"],
  ])("distinguishes spacing from overlap at y=%s", (y, label) => {
    expect(
      renderProofAnnotations(
        [{ kind: "spacing", axis: "y", from: first, to: { ...first, y }, at: 360 }],
        viewport,
      ),
    ).toContain(label);
  });

  it("preserves the selected accent and optional label fields", () => {
    const svg = renderProofAnnotations(
      [
        {
          kind: "outline",
          rect: first,
          text: "Wider account menu",
          detail: "336 CSS px wide",
          badge: "+32",
          color: "#8570ad",
        },
      ],
      viewport,
    );
    expect(svg).toContain("Wider account menu");
    expect(svg).toContain("336 CSS px wide");
    expect(svg).toContain("+32");
    expect(svg).toContain('stroke="#8570ad"');
  });

  it.each([{ color: 'red" onload="alert(1)' }, { detail: "" }, { badge: "x".repeat(17) }])(
    "rejects invalid card presentation fields: %j",
    (fields) => {
      expect(() =>
        validateProofAnnotations(
          [{ kind: "outline", rect: first, text: "Menu", ...fields }],
          viewport,
        ),
      ).toThrow("Invalid proof annotations:");
    },
  );

  it("treats label content as text rather than SVG markup", () => {
    const svg = renderProofAnnotations(
      [{ kind: "outline", rect: first, text: '<script>&"' }],
      viewport,
    );
    expect(svg).toContain("&lt;script&gt;&amp;&quot;");
    expect(svg).not.toContain("<script>");
  });

  it("measures only the intersecting interval when one target contains the other", () => {
    expect(
      renderProofAnnotations(
        [
          {
            kind: "spacing",
            axis: "x",
            from: first,
            to: { x: 150, y: 200, width: 20, height: 40 },
            at: 180,
          },
        ],
        viewport,
      ),
    ).toContain("Overlap 20 px");
  });

  it.each([
    [{ kind: "outline", rect: { ...first, x: 790 } }],
    [{ kind: "arrow", from: { x: Number.NaN, y: 20 }, to: { x: 100, y: 100 } }],
    [{ kind: "alignment", axis: "x", edge: "start", rects: [first] }],
    [{ kind: "spacing", axis: "z", from: first, to: first, at: 20 }],
    [{ kind: "spacing", axis: "x", from: first, to: { ...first, x: 10 }, at: 180 }],
  ])("rejects invalid capture geometry: %j", (annotation) => {
    expect(() => validateProofAnnotations([annotation], viewport)).toThrow(
      "Invalid proof annotations:",
    );
  });
});
