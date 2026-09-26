import { afterAll, describe, expect, it } from "vitest";
import { collectControlUiClassReferences } from "../../scripts/audit-control-ui-dead-css.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

describe("Control UI dead-CSS dynamic stem detection", () => {
  it.each([
    [
      "status template expression",
      "const value = `status-dot--${approval.status}`;",
      ["status-dot--"],
    ],
    [
      "badge Lit template",
      'html`<span class="insight-badge--${badgeClass}"></span>`;',
      ["insight-badge--"],
    ],
    ["palette string concatenation", 'const value = "palette-" + palette.id;', ["palette-"]],
    [
      "ternary-headed template",
      'const value = `${channels ? "channels-wizard" : "wizard-step"}__${name}`;',
      ["channels-wizard__", "wizard-step__"],
    ],
  ] as const)("recognizes a %s stem", (_label, source, expectedStems) => {
    const { stems } = collectControlUiClassReferences(parser.parseSourceFile("fixture.ts", source));
    for (const stem of expectedStems) {
      expect(stems).toContain(stem);
    }
  });
});
