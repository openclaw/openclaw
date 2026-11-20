import { build, type Rolldown } from "vite";
import { controlUiCodeSplitting } from "../../config/control-ui-chunking.ts";

export const modulePath = (relative: string) => new URL(relative, import.meta.url).pathname;

export function importClosure(importsFor: (file: string) => readonly string[]) {
  return (fileName: string) => {
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (!visited.has(file)) {
        visited.add(file);
        importsFor(file).forEach(visit);
      }
    };
    visit(fileName);
    return visited;
  };
}

export function buildFixture(
  entry: string,
  sources: Map<string, string>,
  codeSplitting: Rolldown.CodeSplittingOptions = controlUiCodeSplitting,
) {
  return build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    plugins: [
      {
        name: entry.slice(1),
        enforce: "pre",
        resolveId: (id) => (sources.has(id) ? id : null),
        load: (id) => sources.get(id) ?? null,
      },
    ],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        preserveEntrySignatures: "allow-extension",
        output: { codeSplitting, strictExecutionOrder: true },
      },
    },
  });
}
