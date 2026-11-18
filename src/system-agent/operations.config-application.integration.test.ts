import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "../cli/config-cli.integration.test-harness.js";
import {
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import { executeSystemAgentOperation } from "./operations-execute.js";

// mock-isolation: The audit database is independent of config persistence and runtime receipt delivery.
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: vi.fn() }));

const { withConfigFileHarness } = useConfigCliIntegrationHarness();

describe("Setup config application feedback", () => {
  it("reports saved but deferred through the real approved config writer", async () => {
    await withConfigFileHarness(
      "setup-application-",
      '{"gateway":{"mode":"local"},"logging":{"level":"info"}}',
      async ({ configPath }) => {
        setRuntimeConfigSnapshot({ gateway: { mode: "local" }, logging: { level: "info" } });
        const application = {
          status: "deferred" as const,
          reason: "The previous plugin configuration remains active.",
          appliesWhen: "After the retained plugin work finishes.",
        };
        // The reload owner's receipt is the external boundary of this writer test.
        const unsubscribe = registerRuntimeConfigWriteListener((event) => {
          getRuntimeConfigWriteApplication(event)?.claim()?.settle(application);
        });
        const { runtime, logs } = createTestRuntime();
        try {
          const result = await executeSystemAgentOperation(
            { kind: "config-set", path: "logging.level", value: "debug" },
            runtime,
            { approved: true },
          );
          expect(JSON.parse(fs.readFileSync(configPath, "utf8")).logging.level).toBe("debug");
          expect(result).toMatchObject({ applied: true, runtimeApplication: application });
          expect(logs.join("\n")).toContain("Saved; waiting to apply");
          expect(logs.join("\n")).not.toContain("Change will apply without restarting");
          expect(appendSystemAgentAuditEntry).toHaveBeenLastCalledWith(
            expect.objectContaining({
              details: expect.objectContaining({ runtimeApplication: application }),
            }),
          );
        } finally {
          unsubscribe();
        }
      },
    );
  });
  it.each(["applied", "unclaimed"] as const)(
    "reports %s rather than guessing activation",
    async (status) => {
      await withConfigFileHarness(
        "setup-application-",
        '{"logging":{"level":"info"}}',
        async () => {
          setRuntimeConfigSnapshot({ logging: { level: "info" } });
          const unsubscribe = registerRuntimeConfigWriteListener((event) => {
            if (status === "applied") {
              getRuntimeConfigWriteApplication(event)?.claim()?.settle(status);
            }
          });
          const { runtime, logs } = createTestRuntime();
          try {
            const result = await executeSystemAgentOperation(
              { kind: "config-set", path: "logging.level", value: "debug" },
              runtime,
              { approved: true },
            );
            expect(result).toMatchObject({ applied: true, runtimeApplication: status });
            expect(logs.join("\n")).toContain(
              status === "applied"
                ? "Saved and applied to the active Gateway"
                : "runtime application is not confirmed (unclaimed)",
            );
            const unchanged = await executeSystemAgentOperation(
              { kind: "config-set", path: "logging.level", value: "debug" },
              runtime,
              { approved: true },
            );
            expect(unchanged.runtimeApplication).toBeUndefined();
            expect(logs.join("\n")).toContain("No change");
          } finally {
            unsubscribe();
          }
        },
      );
    },
  );

  it("does not write or request application without approval", async () => {
    const raw = '{"logging":{"level":"info"}}';
    await withConfigFileHarness("setup-application-", raw, async ({ configPath }) => {
      const listener = vi.fn();
      const unsubscribe = registerRuntimeConfigWriteListener(listener);
      try {
        const { runtime } = createTestRuntime();
        expect(
          await executeSystemAgentOperation(
            { kind: "config-set", path: "logging.level", value: "debug" },
            runtime,
          ),
        ).toMatchObject({ applied: false });
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });
});
