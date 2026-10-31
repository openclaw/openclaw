import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "../infra/exec-approvals-store.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";

let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
let runtime: typeof import("./operator-approval-runtime-token.js");
let stateDb: typeof import("../state/openclaw-state-db.js") | undefined;

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-approval-runtime-");
  setTestEnvValue("OPENCLAW_HOME", home.home);
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  vi.resetModules();
  runtime = await import("./operator-approval-runtime-token.js");
  stateDb = await import("../state/openclaw-state-db.js");
});

function writeExecApprovalsToken(token: string): void {
  saveExecApprovals({
    version: 1,
    socket: { path: "~/.openclaw/exec-approvals.sock", token },
    agents: {},
  } satisfies ExecApprovalsFile);
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await stateDb?.closeOpenClawStateDatabaseAsync();
  stateDb?.closeOpenClawStateDatabaseForTest();
  stateDb = undefined;
  execApprovalsStoreTesting.reset();
  vi.resetModules();
  await home.restore();
});

it("derives the shared approval runtime token from the exec approvals socket token", async () => {
  writeExecApprovalsToken("shared-runtime-token");
  const { getOperatorApprovalRuntimeToken: getToken, isOperatorApprovalRuntimeToken: isToken } =
    runtime;
  const sharedToken = await getToken();

  expect(sharedToken).toEqual(expect.any(String));
  expect(sharedToken).not.toBe("shared-runtime-token");
  expect(await isToken(` ${sharedToken} `)).toBe(true);
  expect(await isToken(sharedToken.slice(0, -1))).toBe(false);
  expect(await isToken("shared-runtime-token")).toBe(false);
  expect(await isToken("different-token")).toBe(false);
});

it("does not pin the process fallback once a shared exec approvals token appears", async () => {
  const { getOperatorApprovalRuntimeToken: getToken, isOperatorApprovalRuntimeToken: isToken } =
    runtime;
  const fallback = await getToken();
  writeExecApprovalsToken("late-shared-runtime-token");
  const sharedToken = await getToken();

  expect(sharedToken).not.toBe(fallback);
  expect(sharedToken).not.toBe("late-shared-runtime-token");
  expect(await isToken(fallback)).toBe(true);
  expect(await isToken(sharedToken)).toBe(true);
  expect(await isToken("late-shared-runtime-token")).toBe(false);

  writeExecApprovalsToken("rotated-shared-runtime-token");
  const rotatedToken = await getToken();
  expect(rotatedToken).not.toBe(sharedToken);
  expect(await isToken(sharedToken)).toBe(false);
  expect(await isToken(rotatedToken)).toBe(true);
});

it("keeps a stable process fallback without creating exec-approvals.json", async () => {
  const first = await runtime.getOperatorApprovalRuntimeToken();
  const second = await runtime.getOperatorApprovalRuntimeToken();

  expect(first).toEqual(expect.any(String));
  expect(second).toBe(first);
  expect(fs.existsSync(path.join(home.home, ".openclaw", "exec-approvals.json"))).toBe(false);
});
