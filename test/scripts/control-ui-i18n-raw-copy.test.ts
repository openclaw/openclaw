import { afterAll, describe, expect, it } from "vitest";
import {
  collectControlUiRawCopyFromSource,
  CONTROL_UI_TEST_FILE_PATTERN,
} from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function collect(source: string) {
  const sourceFile = parser.parseSourceFile("ui/src/pages/example.tsx", source);
  expect(parser.getSyntacticDiagnostics()).toEqual([]);
  return collectControlUiRawCopyFromSource(sourceFile).map(({ kind, name, text }) => ({
    kind,
    name,
    text,
  }));
}

const texts = (...values: string[]) =>
  values.map((text) => ({ kind: "html-text", name: "text", text }));
const attribute = (name: string, text: string) => ({ kind: "html-attribute", name, text });

describe("Control UI i18n source scope", () => {
  it.each([
    ["ui/src/pages/model-providers/model-providers-page.login.test-support.ts", true],
    ["ui/src/pages/model-providers/model-providers-page.test-support.tsx", true],
    ["ui/src/pages/example.test.ts", true],
    ["ui/src/pages/example.browser.test.tsx", true],
    ["ui/src/pages/example.node.test.ts", true],
    ["ui/src/pages/model-providers/login-controller.ts", false],
    ["ui/src/pages/model-providers/model-providers-page.tsx", false],
  ] as const)("classifies %s as test-only: %s", (file, testOnly) => {
    expect(CONTROL_UI_TEST_FILE_PATTERN.test(file)).toBe(testOnly);
  });
});

describe("Control UI JSX raw copy", () => {
  it("collects text across elements, fragments, and interpolations", () => {
    expect(
      collect(`const view = <>
        <button>Archive {name} now</button>
        <p>First\n          second &middot; third</p>
        <>Nested copy</>
        <span>123 …</span>
      </>;`),
    ).toEqual(texts("Archive", "now", "First second · third", "Nested copy"));
  });

  it("collects each allowed string attribute once regardless of quoting", () => {
    expect(
      collect(`const view = <>
        <input alt="Preview" aria-label='Search' placeholder={"Find files"} title={\`Open file\`} />
        <span prop:title={"Details"} />
      </>;`),
    ).toEqual([
      attribute("alt", "Preview"),
      attribute("aria-label", "Search"),
      attribute("placeholder", "Find files"),
      attribute("title", "Open file"),
      attribute("title", "Details"),
    ]);
  });

  it("collects static expression segments without treating translation keys as copy", () => {
    expect(
      collect(`const view = <section title={\`Delete \${name}\`}>
        {"Open " + fileName}
        {ready ? "Ready" : (\`Waiting for \${name}\`)}
        {enabled && "Enabled"}
        {label || "Fallback label"}
        {description ?? "No description"}
        {t("common.save")}
      </section>;`),
    ).toEqual([
      attribute("title", "Delete"),
      ...texts("Open", "Ready", "Waiting for", "Enabled", "Fallback label", "No description"),
    ]);
  });

  it("keeps non-copy attributes, callbacks, comments, and translated expressions out", () => {
    expect(
      collect(`const view = <div
        class="panel" id='example' data-title="Metadata" prop:id="Property"
        title={t("common.title")} aria-label={label} placeholder={getPlaceholder("key")}
        onClick={() => console.log('title="Debug only"')}
      >
        {/* title="Comment only" */}
        {t("common.copy")}{count}{123}{" … "}
      </div>;`),
    ).toEqual([]);
  });
});
