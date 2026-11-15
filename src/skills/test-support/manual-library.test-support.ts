/** Synthetic, non-personal bundle shared by registered-read and real Gateway regressions. */
export const manualLibraryInstructions =
  "---\nname: manual-guide\ndescription: A manual library procedure\nuser-invocable: true\ndisable-model-invocation: true\n---\n# R1 instructions\nRead references/guide.md, examples/input.json, and scripts/check.sh.\nDo not replace these pinned instructions with a newer revision.\nEND R1\n";

export const manualLibraryFiles = [
  { path: "references/guide.md", content: "# R1 reference\nComplete reference content.\n" },
  { path: "examples/input.json", content: '{"revision":"R1","value":42}\n' },
  { path: "scripts/check.sh", content: "#!/bin/sh\nprintf 'R1 example\\n'\n", executable: true },
];
