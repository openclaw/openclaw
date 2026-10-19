import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("memory-import", () =>
  import("./memory-import-page.tsx").then((module) => module.MemoryImportPage),
);
