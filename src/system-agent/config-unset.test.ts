import fs from "node:fs";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import {
  createSystemAgentTool,
  type SystemAgentToolOptions,
} from "../agents/tools/system-agent-tool.js";
import {
  createTestRuntime,
  useConfigCliIntegrationHarness,
} from "../cli/config-cli.integration.test-harness.js";
import * as runtimeSchema from "../config/runtime-schema.js";
import { executeSystemAgentOperation } from "./operations.js";

const audit = vi.hoisted(() => vi.fn());
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: audit }));

const { withConfigFileHarness } = useConfigCliIntegrationHarness();

// Exercise the model-facing action, host approval handoff, and real config writer.
// Only audit storage is replaced; the file read, validation, and deletion are real.
describe("setup config unset", () => {
  it.each([false, true])(
    "removes only the approved field unless authority expires during preparation=%s",
    async (expireAuthority) => {
      const raw = JSON.stringify({
        gateway: { mode: "local" },
        agents: {
          defaults: {
            fastModeDefault: false,
            thinkingDefault: "high",
            models: { "openai/gpt-5.2": { params: { fastMode: true } } },
            modelPolicy: { allow: ["openai/gpt-5.2"] },
          },
        },
      });
      await withConfigFileHarness("openclaw-setup-unset-", raw, async ({ configPath }) => {
        audit.mockClear();
        const proposalRef: NonNullable<SystemAgentToolOptions["proposalRef"]> = {};
        const directiveRef: NonNullable<SystemAgentToolOptions["directiveRef"]> = {};
        const args = { action: "config_unset", path: "agents.defaults.fastModeDefault" };
        const tool = createSystemAgentTool({ surface: "gateway", proposalRef, directiveRef });
        await tool.execute("propose", { ...args, approved: true });
        expect(tool.parameters).toMatchObject({
          properties: { action: { enum: expect.arrayContaining(["config_unset"]) } },
        });
        expect(proposalRef.operation).toEqual({ kind: "config-unset", path: args.path });
        expect(directiveRef.current).toBeUndefined();
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        expect(audit).not.toHaveBeenCalled();

        await createSystemAgentTool({
          surface: "gateway",
          proposalRef,
          directiveRef,
          approvalArmed: true,
        }).execute("approve", { ...args, approved: true });
        const directive = directiveRef.current;
        if (directive?.kind !== "approved-operation") {
          throw new Error("Expected the approved deletion to reach the host");
        }
        const output = createTestRuntime();
        let active = true;
        const readSchema = runtimeSchema.readBestEffortRuntimeConfigSchema;
        vi.spyOn(runtimeSchema, "readBestEffortRuntimeConfigSchema").mockImplementation(
          async () => {
            const schema = await readSchema();
            if (expireAuthority) {
              active = false;
            }
            return schema;
          },
        );
        const apply = () =>
          executeSystemAgentOperation(directive.operation, output.runtime, {
            approved: true,
            beforePersistentApply: () => {
              if (!active) {
                throw new Error("request authority expired");
              }
            },
          });
        if (expireAuthority) {
          await expect(apply()).rejects.toThrow();
          expect(output.errors.join("\n")).toContain("request authority expired");
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(audit).not.toHaveBeenCalled();
          return;
        }
        expect(await apply()).toEqual({ applied: true });
        const saved = JSON5.parse(fs.readFileSync(configPath, "utf8"));
        expect(saved.agents.defaults).toEqual({
          thinkingDefault: "high",
          models: { "openai/gpt-5.2": { params: { fastMode: true } } },
          modelPolicy: { allow: ["openai/gpt-5.2"] },
        });
        expect(saved.gateway).toEqual({ mode: "local" });
        expect(audit).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: "config.unset",
            details: { path: args.path },
          }),
        );
      });
    },
  );
});
