// Shared runtime exclusions also govern dependency-free CI inventory selection.
export const sharedVitestExcludePatterns = [
  "dist/**",
  "test/fixtures/**",
  "apps/macos/**",
  "apps/macos/.build/**",
  "**/node_modules/**",
  "**/vendor/**",
  "dist/OpenClaw.app/**",
  "**/._*",
  "**/*.live.test.ts",
  "**/*.e2e.test.ts",
];
