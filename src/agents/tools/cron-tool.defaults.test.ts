import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  callGatewayMock,
  executeCron,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";

installCronToolTestFixture();

const creator = {
  agentSessionKey: "agent:main:main",
  creatorToolAllowlist: ["execute_code", "read", "write"],
  creatorToolAllowlistCaptureRef: {
    value: { version: 1 as const, source: "final-executable-surface" as const },
  },
};

function job(toolsAllow: string[] | undefined = ["execute_code"]) {
  return {
    name: "Reference lookup",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Read the installed reference.", toolsAllow },
  };
}

it.each(["add", "update"] as const)(
  "adds configured tools before the %s request reaches publication",
  async (action) => {
    setRuntimeConfigSnapshot({ cron: { defaultTools: ["read", "read"] } });
    const input = { action, id: "routine", job: job() };
    const original = structuredClone(input);
    await executeCron(input, creator);
    expect(input).toEqual(original);
    const request = readGatewayCall();
    expect(request.method).toBe(`cron.${action}`);
    const shape = action === "add" ? request.params : request.params?.patch;
    expect(shape).toMatchObject({ payload: { toolsAllow: ["execute_code", "read"] } });
    expect(shape).not.toHaveProperty("payload.toolsAllowIsDefault");
    expect(shape).not.toHaveProperty("toolsAllowMode");
  },
);

it.each([
  { action: "add", mode: "exact", toolsAllow: ["execute_code"] },
  { action: "update", mode: "exact", toolsAllow: ["execute_code"] },
  { action: "add", mode: undefined, toolsAllow: [] },
  { action: "update", mode: undefined, toolsAllow: [] },
])("preserves the explicit restriction %j", async ({ action, mode, toolsAllow }) => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await executeCron({ action, id: "routine", toolsAllowMode: mode, job: job(toolsAllow) }, creator);
  const shape = action === "add" ? readGatewayCall().params : readGatewayCall().params?.patch;
  expect(shape).toMatchObject({ payload: { toolsAllow } });
  expect(readGatewayCall().params).not.toHaveProperty("toolsAllowMode");
});

it.each(["add", "update"] as const)(
  "keeps a flat %s opt-out out of the published shape",
  async (action) => {
    setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
    const input = { action, id: "routine", toolsAllowMode: "exact", ...job() };
    const original = structuredClone(input);
    await executeCron(input, creator);
    const request = readGatewayCall();
    const shape = action === "add" ? request.params : request.params?.patch;
    expect(shape).toMatchObject({ payload: { toolsAllow: ["execute_code"] } });
    expect(shape).not.toHaveProperty("toolsAllowMode");
    expect(request.params).not.toHaveProperty("toolsAllowMode");
    expect(input.payload).toEqual(original.payload);
  },
);

it("keeps creation unchanged when defaults are not configured", async () => {
  await executeCron({ action: "add", job: job() }, creator);
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: ["execute_code"] } });
});

it("keeps an omitted selection on the native default policy", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  const input = {
    ...job(),
    payload: { kind: "agentTurn", message: "Use the native default policy." },
  };
  await executeCron({ action: "add", job: input }, creator);
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: ["*"] } });
});

it("rejects an invalid opt-out mode before publishing a selection", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await expect(
    executeCron({ action: "add", toolsAllowMode: "restricted", job: job() }, creator),
  ).rejects.toThrow('toolsAllowMode must be "exact" or omitted');
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("does not add tools to a revision that leaves the saved tool selection alone", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await executeCron({ action: "update", id: "routine", job: { name: "Renamed" } }, creator);
  expect(readGatewayCall()).toEqual({
    method: "cron.update",
    params: { id: "routine", patch: { name: "Renamed" } },
  });
});

it("does not grant a configured default outside the creator's executable surface", async () => {
  setRuntimeConfigSnapshot({ cron: { defaultTools: ["read"] } });
  await expect(
    executeCron(
      { action: "add", job: job() },
      { ...creator, creatorToolAllowlist: ["execute_code"] },
    ),
  ).rejects.toThrow('Requested automation tool "read" cannot be carried');
  expect(callGatewayMock).not.toHaveBeenCalled();
});
