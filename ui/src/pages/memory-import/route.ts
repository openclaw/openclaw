import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("memory-import", () =>
  import("./memory-import-page.tsx").then((module) => module.MemoryImportPage),
);
