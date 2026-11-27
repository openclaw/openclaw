/**
 * Contract tests for system-run approval binding behavior across fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

type FixtureCase = {
  name: string;
  request: {
    host: string;
    command: string;
    commandArgv?: string[];
    cwd?: string | null;
    agentId?: string | null;
    sessionKey?: string | null;
    binding?: {
      argv: string[];
      cwd?: string | null;
      agentId?: string | null;
      sessionKey?: string | null;
      env?: Record<string, string>;
    };
  };
  invoke: {
    argv: string[];
    binding: {
      cwd: string | null;
      agentId: string | null;
      sessionKey: string | null;
      env?: Record<string, string>;
    };
  };
  expected: {
    ok: boolean;
    code?: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING" | "APPROVAL_ENV_MISMATCH";
  };
};

type Fixture = {
  cases: FixtureCase[];
};

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/system-run-approval-binding-contract.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

function buildRequestPayload(entry: FixtureCase): ExecApprovalRequestPayload {
  const payload: ExecApprovalRequestPayload = {
    host: entry.request.host,
    nodeId: "node-1",
    command: entry.request.command,
    commandArgv: entry.request.commandArgv,
    cwd: entry.request.cwd ?? null,
    agentId: entry.request.agentId ?? null,
    sessionKey: entry.request.sessionKey ?? null,
  };
  if (entry.request.binding) {
    payload.systemRunBinding = buildSystemRunApprovalBinding({
      argv: entry.request.binding.argv,
      cwd: entry.request.binding.cwd,
      agentId: entry.request.binding.agentId,
      sessionKey: entry.request.binding.sessionKey,
      env: entry.request.binding.env,
    }).binding;
  }
  return payload;
}

const nonNodeHostCase: FixtureCase = {
  name: "rejects non-node host requests",
  request: {
    host: "gateway",
    command: "echo SAFE",
    binding: { argv: ["echo", "SAFE"] },
  },
  invoke: {
    argv: ["echo", "SAFE"],
    binding: { cwd: null, agentId: null, sessionKey: null },
  },
  expected: { ok: false, code: "APPROVAL_REQUEST_MISMATCH" },
};

describe("system-run approval binding contract fixtures", () => {
  for (const entry of [...fixture.cases, nonNodeHostCase]) {
    test(entry.name, async (testContext) => {
      const approvalManager = createTestApprovalManager(testContext);
      const record = approvalManager.create(buildRequestPayload(entry), 60_000);
      record.requestedByDeviceId = "contract-device";
      await approvalManager.register(record, 60_000);
      expect(await approvalManager.resolve(record.id, "allow-once", "operator")).toBe(true);
      const result = await sanitizeSystemRunParamsForForwarding({
        nodeId: "node-1",
        client: { connect: { device: { id: "contract-device" } } },
        rawParams: {
          command: entry.invoke.argv,
          ...entry.invoke.binding,
          approved: true,
          runId: record.id,
        },
        execApprovalManager: approvalManager,
      });

      expect(result.ok).toBe(entry.expected.ok);
      if (!entry.expected.ok) {
        if (result.ok) {
          throw new Error("expected approval mismatch");
        }
        expect(result.details?.code).toBe(entry.expected.code);
      }
    });
  }
});
