import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("emits portable module specifiers in Gateway validator declarations", () => {
  const directory = new URL(
    "../../packages/gateway-protocol/src/compiled/protocol.generated/",
    import.meta.url,
  );
  const specifiers = readdirSync(directory)
    .filter((name) => name.endsWith(".d.ts"))
    .flatMap((name) =>
      Array.from(
        readFileSync(new URL(name, directory), "utf8").matchAll(/\bimport\("([^"]+)"\)/gu),
        (match) => match[1]!,
      ),
    );
  expect(specifiers.length).toBeGreaterThan(0);
  for (const specifier of specifiers) {
    expect(specifier).not.toContain("\\");
  }
});
