import { afterAll, describe, expect, it } from "vitest";
import { collectControlUiRawCopyFromSource } from "../../scripts/lib/control-ui-i18n-raw-copy.ts";
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

describe("Control UI JSX raw copy", () => {
  it("collects text across elements, fragments, and interpolations", () => {
    expect(
      collect(`const view = <>
        <button>Archive {name} now</button>
        <p>First\n          second &middot; third</p>
        <>Nested copy</>
        <span>123 …</span>
      </>;`),
    ).toEqual([
      { kind: "html-text", name: "text", text: "Archive" },
      { kind: "html-text", name: "text", text: "now" },
      { kind: "html-text", name: "text", text: "First second · third" },
      { kind: "html-text", name: "text", text: "Nested copy" },
    ]);
  });

  it("collects each allowed string attribute once regardless of quoting", () => {
    expect(
      collect(`const view = <>
        <input alt="Preview" aria-label='Search' placeholder={"Find files"} title={\`Open file\`} />
        <span prop:title={"Details"} />
      </>;`),
    ).toEqual([
      { kind: "html-attribute", name: "alt", text: "Preview" },
      { kind: "html-attribute", name: "aria-label", text: "Search" },
      { kind: "html-attribute", name: "placeholder", text: "Find files" },
      { kind: "html-attribute", name: "title", text: "Open file" },
      { kind: "html-attribute", name: "title", text: "Details" },
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
      { kind: "html-attribute", name: "title", text: "Delete" },
      { kind: "html-text", name: "text", text: "Open" },
      { kind: "html-text", name: "text", text: "Ready" },
      { kind: "html-text", name: "text", text: "Waiting for" },
      { kind: "html-text", name: "text", text: "Enabled" },
      { kind: "html-text", name: "text", text: "Fallback label" },
      { kind: "html-text", name: "text", text: "No description" },
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
