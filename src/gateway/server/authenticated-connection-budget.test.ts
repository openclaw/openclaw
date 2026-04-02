import { describe, expect, it } from "vitest";
import {
  createAuthenticatedConnectionBudget,
  getMaxAuthenticatedConnectionsPerIdentityFromEnv,
} from "./authenticated-connection-budget.js";

describe("authenticated connection budget", () => {
  it("falls back to the default limit for invalid env values", () => {
    expect(
      getMaxAuthenticatedConnectionsPerIdentityFromEnv({
        OPENCLAW_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY: "abc",
      } as NodeJS.ProcessEnv),
    ).toBe(8);
    expect(
      getMaxAuthenticatedConnectionsPerIdentityFromEnv({
        OPENCLAW_MAX_AUTHENTICATED_CONNECTIONS_PER_IDENTITY: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(8);
  });

  it("reclaims a device slot after release", () => {
    const budget = createAuthenticatedConnectionBudget(1);

    expect(budget.acquire("device-1")).toBe(true);
    expect(budget.acquire("device-1")).toBe(false);

    budget.release("device-1");

    expect(budget.acquire("device-1")).toBe(true);
  });
});
