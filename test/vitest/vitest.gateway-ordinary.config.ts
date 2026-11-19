import { defineConfig } from "vitest/config";
import { createGatewayVitestConfig } from "./vitest.gateway.config.ts";

const config = createGatewayVitestConfig();

export default defineConfig({
  ...config,
  // Unsharded Gateway tests still need the process-main-thread SQLite broker.
  test: { ...config.test, pool: "forks" },
});
