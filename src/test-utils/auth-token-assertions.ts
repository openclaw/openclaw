import { expect } from "vitest";
import type { MullusiConfig } from "../config/config.js";

export function expectGeneratedTokenPersistedToGatewayAuth(params: {
  generatedToken?: string;
  authToken?: string;
  persistedConfig?: MullusiConfig;
}) {
  expect(params.generatedToken).toMatch(/^[0-9a-f]{48}$/);
  expect(params.authToken).toBe(params.generatedToken);
  expect(params.persistedConfig?.gateway?.auth?.mode).toBe("token");
  expect(params.persistedConfig?.gateway?.auth?.token).toBe(params.generatedToken);
}
