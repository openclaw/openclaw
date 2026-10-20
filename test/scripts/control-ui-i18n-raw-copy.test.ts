import { afterAll, expect, it } from "vitest";
import {
  collectControlUiRawCopyFromSource,
  CONTROL_UI_TEST_FILE_PATTERN,
} from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const texts = (...values: string[]) =>
  values.map((text) => ({ kind: "html-text", name: "text", text }));
const attribute = (name: string, text: string) => ({ kind: "html-attribute", name, text });

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

it.each([
  {
    name: "collects text across elements, fragments, and interpolations",
    source: `const view = <>
        <button>Archive {name} now</button>
        <p>First\n          second &middot; third</p>
        <>Nested copy</>
        <span>123 …</span>
      </>;`,
    expected: texts("Archive", "now", "First second · third", "Nested copy"),
  },
  {
    name: "collects each allowed string attribute once regardless of quoting",
    source: `const view = <>
        <input alt="Preview" aria-label='Search' placeholder={"Find files"} title={\`Open file\`} />
        <span prop:title={"Details"} />
      </>;`,
    expected: [
      attribute("alt", "Preview"),
      attribute("aria-label", "Search"),
      attribute("placeholder", "Find files"),
      attribute("title", "Open file"),
      attribute("title", "Details"),
    ],
  },
  {
    name: "collects static expression segments without treating translation keys as copy",
    source: `const view = <section title={\`Delete \${name}\`}>
        {"Open " + fileName}
        {ready ? "Ready" : (\`Waiting for \${name}\`)}
        {enabled && "Enabled"}
        {label || "Fallback label"}
        {description ?? "No description"}
        {t("common.save")}
      </section>;`,
    expected: [
      attribute("title", "Delete"),
      ...texts("Open", "Ready", "Waiting for", "Enabled", "Fallback label", "No description"),
    ],
  },
  {
    name: "keeps non-copy attributes, callbacks, comments, and translated expressions out",
    source: `const view = <div
        class="panel" id='example' data-title="Metadata" prop:id="Property"
        title={t("common.title")} aria-label={label} placeholder={getPlaceholder("key")}
        onClick={() => console.log('title="Debug only"')}
      >
        {/* title="Comment only" */}
        {t("common.copy")}{count}{123}{" … "}
      </div>;`,
    expected: [],
  },
])("$name", ({ source, expected }) => {
  const sourceFile = parser.parseSourceFile("ui/src/pages/example.tsx", source);
  expect(parser.getSyntacticDiagnostics()).toEqual([]);
  const copy = collectControlUiRawCopyFromSource(sourceFile);
  expect(copy.map(({ kind, name, text }) => ({ kind, name, text }))).toEqual(expected);
});
