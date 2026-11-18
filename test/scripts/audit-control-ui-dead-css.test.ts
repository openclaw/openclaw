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

describe("Control UI JSX class references", () => {
  it("collects string, nested array, object, shorthand, and conditional class names", () => {
    const source = `const View = () => <div class={[
      "base secondary", { active: state, "is-busy is-ready": busy }, [{ compact }],
      condition && { shown: true }, condition ? { yes: true } : { no: true }
    ]} />;`;
    const { literalClasses } = collectControlUiClassReferences(
      parser.parseSourceFile("fixture.tsx", source),
    );
    expect([...literalClasses]).toEqual(
      expect.arrayContaining([
        "base",
        "secondary",
        "active",
        "is-busy",
        "is-ready",
        "compact",
        "shown",
        "yes",
        "no",
      ]),
    );
  });

  it("retains dynamic class families in JSX attributes and computed object keys", () => {
    const source =
      'const View = () => <div class={[`status--${status}`, { [`color-${color}`]: true }, `${compact ? "small-item" : "large-item"}__${part}`]} />;';
    const { stems } = collectControlUiClassReferences(
      parser.parseSourceFile("fixture.tsx", source),
    );
    expect([...stems]).toEqual(
      expect.arrayContaining(["status--", "color-", "small-item__", "large-item__"]),
    );
  });

  it("retains class keys from literal and nested object spreads", () => {
    const source = `const View = () => <div class={{
      ...{ active: true, ...{ nested: true } },
      ...(condition ? { yes: true } : { no: true }),
      ...(condition && { shown: true })
    }} />;`;
    const { literalClasses } = collectControlUiClassReferences(
      parser.parseSourceFile("fixture.tsx", source),
    );
    expect([...literalClasses]).toEqual(
      expect.arrayContaining(["active", "nested", "yes", "no", "shown"]),
    );
  });
});
