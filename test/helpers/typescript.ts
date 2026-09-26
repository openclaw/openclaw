import path from "node:path";
import type { Diagnostic } from "typescript/unstable/sync";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

export function typeCheckSources(files: Record<string, string>): readonly Diagnostic[] {
  const cwd = process.cwd();
  const configFileName = path.join(cwd, "__openclaw_typecheck__.json");
  const sources = Object.fromEntries(
    Object.entries(files).map(([fileName, source]) => [path.resolve(cwd, fileName), source]),
  );
  using session = createNativeTypeScriptProject({
    cwd,
    configFileName,
    files: {
      ...sources,
      [configFileName]: JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          types: [],
          target: "esnext",
          skipLibCheck: false,
        },
        files: Object.keys(sources),
      }),
    },
  });
  return collectNativeTypeScriptDiagnostics(session.project);
}
