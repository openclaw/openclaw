export const stateStartupCorpusTestFiles = [
  "src/config/state-startup-corpus.test.ts",
  ...Array.from(
    { length: 7 },
    (_, index) => `src/config/state-startup-corpus.part-${index + 2}.test.ts`,
  ),
];

export const startupCorpusTestFiles = [
  "src/config/config-startup-corpus.test.ts",
  ...stateStartupCorpusTestFiles,
];
