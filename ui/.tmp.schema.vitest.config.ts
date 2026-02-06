import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/config/schema.test.ts"],
    environment: "node",
  },
});
