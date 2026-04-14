import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-ui",
  includePatterns: [
    "ui/src/ui/app-chat.test.ts",
    "ui/src/ui/chat/**/*.test.ts",
    "ui/src/ui/views/agents-utils.test.ts",
    "ui/src/ui/views/channels.test.ts",
    "ui/src/ui/views/chat.test.ts",
    "ui/src/ui/views/dreams.test.ts",
    "ui/src/ui/views/usage-render-details.test.ts",
    "ui/src/ui/controllers/agents.test.ts",
    "ui/src/ui/controllers/chat.test.ts",
  ],
});
