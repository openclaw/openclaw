import { afterEach, expect, it, vi } from "vitest";
import { createDatabaseStoreDiagnostic } from "../infra/database-engine/diagnostic-record.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn() }));
// mock-isolation: Status consumes admitted facts; do not inspect host databases.
vi.mock("../infra/database-engine/admitted-diagnostics.js", () => ({
  describeAdmittedDatabaseStores: mocks.describe,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const store = createDatabaseStoreDiagnostic({
  family: "state",
  path: "/fixture/openclaw-state.sqlite",
  configured: { default: "postgres", override: null, effective: "postgres", fixedLocal: false },
});

it.each(["local", "remote", "url-override", "admitted", "failed"])(
  "preserves store authority and redaction for %s targets",
  async (target) => {
    mocks.describe.mockReturnValue([store]);
    vi.stubEnv(
      "OPENCLAW_GATEWAY_URL",
      target === "url-override" ? "wss://gateway.example.invalid" : undefined,
    );
    if (target === "failed") {
      mocks.describe.mockImplementationOnce(() => {
        throw new Error("connect postgres://fixture:private@localhost/db");
      });
    }
    const result = await resolveStatusDatabaseEngines(
      target === "remote" || target === "admitted" ? { gateway: { mode: "remote" } } : {},
      target === "admitted" ? [store] : undefined,
    );
    expect(result).toEqual(
      target === "local" || target === "admitted"
        ? { source: "admitted", stores: [store] }
        : {
            source: "unavailable",
            stores: [],
            reason:
              target === "failed"
                ? "Physical stores unknown: admitted facts unavailable. Run openclaw doctor for recovery steps."
                : "Physical stores unknown: the selected Gateway has not supplied admitted database facts. Run openclaw doctor on the Gateway host.",
          },
    );
    expect(mocks.describe).toHaveBeenCalledTimes(["local", "failed"].includes(target) ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("private");
  },
);
